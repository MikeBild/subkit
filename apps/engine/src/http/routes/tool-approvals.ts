// The approval portal — where a HUMAN decides on a tool approval.
//
//   GET  /v1/tool-approvals/decide?grant=skag_…  — UNAUTHENTICATED
//        (grant-token auth). Resolves the single-use grant WITHOUT consuming it
//        — the human still has to submit the form — and renders exactly what
//        will be written: the tool, the workflow, the environment, and the
//        `would_write` list. Invalid/expired grant → 400 HTML error page.
//
//   POST /v1/tool-approvals/decide               — UNAUTHENTICATED
//        (grant-token auth). Form-encoded body — cannot be expressed cleanly via
//        @hono/zod-openapi (same precedent as POST /v1/connectors/{id}/credentials/setup
//        and the MCP OAuth consent/token endpoints). Grants or declines through
//        the approval's own atomic CAS, which is what makes the decision
//        single-use. Both outcomes write an audit row, with the HUMAN as actor.
//
// AUTH — TWO INDEPENDENT FACTS, both required.
//
//   WHICH approval may be decided: possession of the one-shot `skag_…` grant,
//   reachable without an API key because the approver has a browser, not a
//   token. Stored as a sha256 digest, bound to one approval, expiring with it.
//
//   WHO is deciding: a signed-in account in this approval's tenant. The grant is
//   NOT an identity. On its own it left `granted_by_user_id` NULL on 100% of
//   grants in production — an unattributable authorization in a system whose
//   whole promise is an audited one, and a link anyone could forward. So an
//   unidentified browser is sent through the provider-neutral login funnel
//   (`/v1/identity/login/start`, the same round-trip the MCP consent screen
//   uses) and returned here; an unidentified POST is refused outright rather
//   than recorded as "somebody".
//
// The decision form additionally carries a CSRF token bound to BOTH the
// approver's session and the grant's digest, so a cross-site post cannot
// release a write on a signed-in approver's behalf and a token minted for one
// approval cannot be replayed against another.
//
// `grantApproval` writes `actor_id` onto the APPROVAL_GRANTED row, and that
// actor is the human. The MCP principal that REQUESTED the write is recorded on
// APPROVAL_REQUESTED and is never attributed the decision.
//
// WHAT IS NEVER RENDERED. `args_ciphertext`, the decrypted args, and the approval
// id in any copyable form. The write preview is scrubbed through the
// `SECRET_PATTERNS` dual contract before it reaches the browser — a resolved URL
// can carry a query-mode credential. The plaintext grant token appears only in
// the hidden `grant` field so the browser can round-trip it on submit.

import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import { signLoginState } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import { completeApprovalBackedElicitation } from "../../conversations/index.ts";
import type { Db } from "../../db/client.ts";
import { users } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { enqueueApprovalElicitationResume, getBoss } from "../../queue/index.ts";
import {
  APPROVAL_PORTAL_PATH,
  declineApproval,
  grantApproval,
  resolveApprovalPortalToken,
} from "../../tools/index.ts";
import type { AppEnv } from "../openapi.ts";
import {
  deriveSessionSecret,
  parseFormBody,
  resolveSession,
  sessionIsLive,
  signCsrfToken,
  verifyCsrfToken,
} from "./oauth/shared.ts";
import { resolveAuthLocale } from "./oauth/ui.ts";
import { approvalCopy, approvalDenialCopy } from "./tool-approval-copy.ts";
import {
  alreadyDecidedPage,
  approvalStatusPage,
  buildApprovalDecisionHtml,
} from "./tool-approval-ui.ts";

/** sha256 hex — binds a CSRF token to the exact grant it was minted for without
 *  putting the plaintext token into the signed payload. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The engine's own public origin, for the login round-trip. */
function publicBaseUrl(): string {
  return getConfig().server.public_base_url;
}

// Min-20 guards against random short strings; no semantic validation here —
// `resolveApprovalPortalToken` enforces the prefix, the sha256 match, and expiry.
const ApprovalGrantQuery = z.object({ grant: z.string().min(20) }).openapi("ApprovalGrantQuery");

const approvalPortalPageRoute = createRoute({
  method: "get",
  path: APPROVAL_PORTAL_PATH,
  tags: ["tool-approvals"],
  summary: "Browser-openable approval portal (single-use grant token)",
  // Unauthenticated by design: the engine hands this URL to an operator to open
  // in a browser. Authentication is the single-use opaque `grant` query
  // parameter (skag_… token), stored as a sha256 digest on the approval row.
  // This GET RESOLVES ONLY — the decision happens on POST.
  request: { query: ApprovalGrantQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    400: {
      description: "Grant invalid/expired (HTML error page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

/** A grant token rides in the query string, so keep it out of referrers and
 *  shared caches. */
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

/** The signed-in human deciding on an approval, with the session their CSRF
 *  token is bound to. */
interface ApprovalApprover {
  user_id: string;
  session_id: string;
  email: string;
}

/**
 * The human who decided, or null when we cannot name one.
 *
 * A live browser session in THIS approval's tenant names the approver. Anything else —
 * an anonymous browser, an API key, a system account, a user from another
 * tenant — is null. Recording the requesting machine as the approver would
 * describe a decision nobody made.
 *
 * Read the signed session cookie directly so the portal does not depend on
 * which auth providers a deployment registers. A user-owned API key still
 * authenticates a machine caller; it cannot substitute a browser decision.
 *
 * The session row is re-checked for liveness, so a revoked session cannot
 * approve on the strength of a still-valid cookie signature.
 */
async function resolveApprovalApprover(
  c: { req: { raw: Request } },
  db: Db,
  tenant_id: string,
): Promise<ApprovalApprover | null> {
  const session = await resolveSession(c.req.raw);
  if (
    session &&
    session.tenant_id === tenant_id &&
    (await sessionIsLive(db, session.session_id, session.tenant_id))
  ) {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.id, session.user_id),
          eq(users.tenant_id, tenant_id),
          eq(users.status, "active"),
          isNull(users.deleted_at),
        ),
      )
      .limit(1);
    if (!user) return null;
    return {
      user_id: session.user_id,
      session_id: session.session_id,
      email: user.email,
    };
  }

  return null;
}

/** Send an unidentified browser through the provider-neutral login funnel and
 *  back to this same approval link.
 *
 *  A governed write has to name the human who released it. The grant token
 *  scopes WHICH approval may be decided; it says nothing about WHO is deciding,
 *  so on its own it left `granted_by_user_id` NULL on every grant in production
 *  — an unattributable authorization in a system whose whole promise is an
 *  audited one. The `login_state` round-trip is the same one the MCP consent
 *  screen uses. */
async function redirectToSignIn(grant: string, publicBaseUrl: string): Promise<Response> {
  const back = new URL(APPROVAL_PORTAL_PATH, publicBaseUrl);
  back.searchParams.set("grant", grant);
  const loginUrl = new URL("/v1/identity/login/start", publicBaseUrl);
  loginUrl.searchParams.set("login_state", await signLoginState({ redirect_to: back.toString() }));
  return Response.redirect(loginUrl.toString(), 302);
}

export function registerToolApprovalRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── GET /v1/tool-approvals/decide?grant=skag_… ────────────────────────────
  // Unauthenticated browser-grant path. RESOLVES ONLY — does not decide.
  app.openapi(approvalPortalPageRoute, async (c) => {
    const db = c.get("db");
    const { grant } = c.req.valid("query");
    const locale = resolveAuthLocale(c.req.header("accept-language"));
    const copy = approvalCopy(locale);

    const view = await resolveApprovalPortalToken(db, grant);
    if (!view) {
      // Never echo the grant token, in HTML or in logs.
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.invalid_grant",
        msg: "approval grant not found or expired — a browser opened a dead link",
      });
      const { html, status } = approvalStatusPage(locale, copy.deadTitle, copy.deadMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    if (view.state !== "pending") {
      const { html, status } = alreadyDecidedPage(view, locale);
      return c.body(html, status, HTML_HEADERS);
    }

    // WHO is deciding. An unidentified browser goes through the login funnel and
    // comes back here — grant possession scopes the approval, it does not name a
    // human, and a governed write must record one.
    const approver = await resolveApprovalApprover(c, db, view.tenant_id);
    if (!approver) {
      return await redirectToSignIn(grant, publicBaseUrl());
    }

    const csrfToken = await signCsrfToken(deriveSessionSecret(), {
      session_id: approver.session_id,
      grant_sha256: sha256Hex(grant),
    });
    return c.body(
      buildApprovalDecisionHtml(view, grant, approver, csrfToken, locale),
      200,
      HTML_HEADERS,
    );
  });

  // ── POST /v1/tool-approvals/decide ────────────────────────────────────────
  // Raw handler — form-encoded body (an HTML <form> POST). Cannot be expressed
  // cleanly via @hono/zod-openapi; same precedent as
  // http/routes/connectors/credentials-setup.ts. The body is still validated at
  // the boundary: `grant` and a closed set of `decision` values, below.
  app.post(APPROVAL_PORTAL_PATH, async (c) => {
    const db = c.get("db");
    const form = await parseFormBody(c.req.raw);
    const grant = form.get("grant") ?? "";
    const decision = form.get("decision") ?? "";
    const language = z.enum(["de", "en"]).safeParse(form.get("language"));
    const locale = language.success
      ? language.data
      : resolveAuthLocale(c.req.header("accept-language"));
    const copy = approvalCopy(locale);

    if (
      !grant ||
      (decision !== "approve" && decision !== "decline" && !(decision === "" && language.success))
    ) {
      const { html, status } = approvalStatusPage(locale, copy.invalidTitle, copy.invalidMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    const view = await resolveApprovalPortalToken(db, grant);
    if (!view) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.invalid_grant_on_submit",
        msg: "approval grant not found or expired at decision time",
        decision,
      });
      const { html, status } = approvalStatusPage(locale, copy.deadTitle, copy.deadMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    // Tenant comes from the resolved row, never from the request.
    //
    // WHO released this write. Required, not best-effort: `granted_by_user_id`
    // used to be NULL on every grant in production, because grant possession is
    // not an identity and a browser sends a cookie rather than a Bearer token.
    // An unattributable authorization is exactly what an audited system must not
    // accept, so an unidentified submitter is refused here rather than recorded
    // as "somebody".
    const approver = await resolveApprovalApprover(c, db, view.tenant_id);
    if (!approver) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.unidentified_submitter",
        msg: "an unidentified browser submitted an approval decision; nothing was decided",
        approval_id: view.approval_id,
        tenant_id: view.tenant_id,
        decision,
      });
      const { html, status } = approvalStatusPage(locale, copy.signTitle, copy.signMessage);
      return c.body(html, status, HTML_HEADERS);
    }
    const granted_by_user_id = approver.user_id;

    // CSRF: the token is bound to THIS session and THIS grant, so a cross-site
    // post cannot release a write on behalf of a signed-in approver, and a token
    // minted for one approval cannot be replayed against another.
    const csrf = await verifyCsrfToken(deriveSessionSecret(), form.get("csrf_token") ?? "");
    if (
      !csrf ||
      csrf.session_id !== approver.session_id ||
      csrf.grant_sha256 !== sha256Hex(grant)
    ) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.csrf_rejected",
        msg: "approval decision rejected: missing or mismatched CSRF token",
        approval_id: view.approval_id,
        tenant_id: view.tenant_id,
        user_id: approver.user_id,
        decision,
      });
      const { html, status } = approvalStatusPage(locale, copy.csrfTitle, copy.csrfMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    // A language selection only renders the same authenticated request. It does
    // not grant, decline, consume, extend expiry or enqueue a continuation.
    if (decision === "") {
      if (view.state !== "pending") {
        const { html, status } = alreadyDecidedPage(view, locale);
        return c.body(html, status, HTML_HEADERS);
      }
      return c.body(
        buildApprovalDecisionHtml(view, grant, approver, form.get("csrf_token") ?? "", locale),
        200,
        HTML_HEADERS,
      );
    }

    // The CAS inside these two is what makes the decision single-use: two tabs
    // racing this token decide exactly once, and a token replayed after its
    // decision loses. Both write the audit row, with the human as actor.
    const result =
      decision === "approve"
        ? await grantApproval({
            db,
            approval_id: view.approval_id,
            tenant_id: view.tenant_id,
            granted_by_user_id,
            via: "portal",
          })
        : await declineApproval({
            db,
            approval_id: view.approval_id,
            tenant_id: view.tenant_id,
            granted_by_user_id,
            via: "portal",
          });

    if (!result.ok) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.decision_refused",
        msg: "a human decided on an approval that was no longer decidable",
        approval_id: view.approval_id,
        tenant_id: view.tenant_id,
        user_id: granted_by_user_id,
        decision,
        error_code: result.code,
      });
      const { html, status } = approvalStatusPage(
        locale,
        copy.refusedTitle,
        `${approvalDenialCopy(result.code, locale)} ${copy.unchanged}`,
      );
      return c.body(html, status, HTML_HEADERS);
    }

    // Close the loop back to a paused CONVERSATION, if this approval gates one.
    // The grant above decided the `tool_approvals` row; a policy-gated turn
    // additionally waits on a `conversation_elicitations` row that only the
    // elicitation's resolution reactivates. Stage the human's answer onto it and
    // enqueue the resume in THIS request, so the decision owns its effect
    // instead of waiting for an MCP client poll that a browser-only approver
    // never makes — the gap that stranded every approval-backed confirm in
    // production and then timed them out claiming nothing ran.
    //
    // The turn itself runs in the queue worker: `respondElicitation` executes a
    // full LLM turn in-process, so driving it here would hold this page open for
    // minutes. Best-effort by design — a zero match is normal (a direct tool
    // dispatch or a chat fast-path run has no paused conversation row), and
    // nothing here may fail the human's already-recorded decision.
    const completion = await completeApprovalBackedElicitation(
      {
        tenant_id: view.tenant_id,
        approval_id: view.approval_id,
        decision,
        approver_user_id: granted_by_user_id,
        resume: (resume) =>
          enqueueApprovalElicitationResume(resume, db, c.get("boss") ?? getBoss()),
      },
      db,
    );

    logger.info({
      module: "tool_approvals",
      action: decision === "approve" ? "approval.portal.granted" : "approval.portal.declined",
      msg: "a human decided on a tool approval through the portal",
      approval_id: view.approval_id,
      tenant_id: view.tenant_id,
      user_id: granted_by_user_id,
      tool: result.tool,
      surface: result.surface,
      elicitations_matched: completion.matched,
      elicitations_resumed: completion.resumed,
    });

    // Queueing continuation is not evidence that execution has started.
    const { html, status } =
      decision === "approve"
        ? approvalStatusPage(
            locale,
            copy.approvedTitle,
            completion.resumed > 0 ? copy.queuedMessage : copy.approvedMessage,
            200,
          )
        : approvalStatusPage(locale, copy.declinedTitle, copy.declinedMessage, 200);
    return c.body(html, status, HTML_HEADERS);
  });
}
