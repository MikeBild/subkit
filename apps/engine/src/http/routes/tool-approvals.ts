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
import { type ResolvedPrincipal, signLoginState } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import { buildCallbackPageHtml, escapeHtml } from "../../connectors/index.ts";
import { completeApprovalBackedElicitation } from "../../conversations/index.ts";
import type { Db } from "../../db/client.ts";
import { logger, scrubString } from "../../logging/index.ts";
import { enqueueApprovalElicitationResume, getBoss } from "../../queue/index.ts";
import {
  APPROVAL_PORTAL_PATH,
  type ApprovalDecisionDenialCode,
  type ApprovalPortalView,
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
} as const;

/** One page for unknown, malformed, and expired tokens. Which approvals exist is
 *  not an anonymous browser's to learn. */
const LINK_DEAD_PAGE = {
  kind: "error",
  title: "Approval link expired",
  message:
    "This approval link has expired or was already used. Nothing has been approved. Ask the assistant to re-issue the request to get a fresh link.",
} as const;

/** Browser copy for a decision that lost the CAS. Rewritten rather than
 *  forwarded: `ApprovalDecisionResult.message` names the approval id, which is
 *  the model's `confirm_id` and must never be rendered where a human can copy it
 *  back out. The id still reaches the structured log and the audit row. */
const DECISION_REFUSED_COPY: Record<ApprovalDecisionDenialCode, string> = {
  approval_not_found: "This approval no longer exists. Nothing has been approved.",
  approval_already_granted:
    "This request was already approved. The assistant will carry it out — there is nothing left to decide.",
  approval_already_declined: "This request was already declined. Declining is final.",
  approval_already_used: "This request was already approved and carried out.",
  approval_expired:
    "This request expired before anyone decided on it, so nothing ran. Ask the assistant to re-issue it.",
};

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
 * A user principal in THIS approval's tenant is the approver. Anything else —
 * an anonymous browser, an API key, a system account, a user from another
 * tenant — is null. Recording the requesting machine as the approver would
 * describe a decision nobody made.
 *
 * Two sources, both legitimate:
 *   - the auth middleware's principal (a Bearer/`?token=` caller, and now also
 *     the `subkit_session` cookie via the browser-session provider), and
 *   - the session cookie read directly, which is what a browser that just came
 *     back from the login funnel carries. Read as a fallback so the portal does
 *     not depend on which providers a deployment happens to register.
 *
 * The session row is re-checked for liveness, so a revoked session cannot
 * approve on the strength of a still-valid cookie signature.
 */
async function resolveApprovalApprover(
  c: { get: (k: "principal") => ResolvedPrincipal | undefined; req: { raw: Request } },
  db: Db,
  tenant_id: string,
): Promise<ApprovalApprover | null> {
  const session = await resolveSession(c.req.raw);
  if (
    session &&
    session.tenant_id === tenant_id &&
    (await sessionIsLive(db, session.session_id, session.tenant_id))
  ) {
    return {
      user_id: session.user_id,
      session_id: session.session_id,
      email: session.email,
    };
  }

  const principal = c.get("principal");
  if (principal?.kind === "user" && principal.tenant_id === tenant_id) {
    // A token-authenticated approver (the shape the route's own tests use) has
    // no browser session; bind the CSRF token to the principal instead so the
    // check stays meaningful rather than being skipped.
    return {
      user_id: principal.id,
      session_id: principal.session_id ?? `principal:${principal.id}`,
      email: principal.email ?? "an authenticated account",
    };
  }
  return null;
}

function environmentLabel(view: ApprovalPortalView): string {
  return view.execution_mode ?? "not environment-scoped";
}

/**
 * Render the `would_write` rows.
 *
 * `url` is the only field that can carry a secret — a query-mode connector puts
 * its credential in the query string — so it is the only one passed through
 * `scrubString`. `step` is a step key and `method` an HTTP verb; running the
 * generic high-entropy matcher over them buys nothing and has corrupted
 * legitimate identifiers before.
 */
function buildWouldWriteHtml(view: ApprovalPortalView): string {
  const rows = view.preview?.would_write ?? [];
  if (rows.length === 0) {
    return '<p class="empty">This call holds no external writes the engine could preview. Approving releases the tool call named above.</p>';
  }
  const body = rows
    .map(
      (w) =>
        `<tr><td>${escapeHtml(w.step)}</td><td>${escapeHtml(w.method ?? "—")}</td><td>${escapeHtml(
          w.url ? scrubString(w.url) : "—",
        )}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Step</th><th>Method</th><th>URL</th></tr></thead><tbody>${body}</tbody></table>`;
}

function pageShell(title: string, main: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #111; }
    main { max-width: 720px; margin: 64px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p.sub { color: #555; margin: 0 0 24px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 24px; font-size: 14px; }
    dt { color: #555; }
    dd { margin: 0; font-family: ui-monospace, monospace; }
    table { width: 100%; border-collapse: collapse; margin: 0 0 24px; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; word-break: break-all; }
    th { color: #555; font-weight: 600; }
    td { font-family: ui-monospace, monospace; }
    p.empty { color: #555; font-size: 14px; margin: 0 0 24px; }
    .actions { display: flex; gap: 12px; }
    button { padding: 10px 18px; font-size: 14px; border: none; border-radius: 6px; cursor: pointer; }
    button.approve { background: #16a34a; color: #fff; }
    button.decline { background: #fff; color: #dc2626; border: 1px solid #dc2626; }
  </style>
</head>
<body>
  <main>${main}</main>
</body>
</html>`;
}

/**
 * Render the decision form. The plaintext grant token is placed ONLY in the
 * hidden `grant` field so the browser round-trips it on submit; it must never
 * appear anywhere else in this response. The approval id appears nowhere at all.
 *
 * `csrf_token` is bound to the approver's session, so a cross-site form post
 * cannot release a write using a link someone forwarded them.
 */
function buildApprovalDecisionHtml(
  view: ApprovalPortalView,
  grant: string,
  approver: { email: string },
  csrfToken: string,
): string {
  const target = view.workflow_slug
    ? `<dt>Workflow</dt><dd>${escapeHtml(view.workflow_slug)}</dd>`
    : "";
  return pageShell(
    "Approve this action?",
    `
    <h1>Approve this action?</h1>
    <p class="sub">An assistant asked to perform the write below and paused. Nothing has run. This link is single-use and expires shortly.</p>
    <dl>
      <dt>Tool</dt><dd>${escapeHtml(view.tool)}</dd>
      ${target}
      <dt>Environment</dt><dd>${escapeHtml(environmentLabel(view))}</dd>
      <dt>Requested via</dt><dd>${escapeHtml(view.surface)}</dd>
    </dl>
    <h2 style="font-size:15px;margin:0 0 12px;">What will be written</h2>
    ${buildWouldWriteHtml(view)}
    <p class="sub">Signed in as ${escapeHtml(approver.email)} — your decision is recorded against this account.</p>
    <form method="POST" action="${APPROVAL_PORTAL_PATH}">
      <input type="hidden" name="grant" value="${escapeHtml(grant)}" />
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <div class="actions">
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
        <button class="decline" type="submit" name="decision" value="decline">Decline</button>
      </div>
    </form>`,
  );
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

/** A token replayed after its decision. It can produce no second decision, so
 *  the page reports the outcome and withholds the write list. */
function alreadyDecidedPage(view: ApprovalPortalView): { html: string; status: 200 | 400 } {
  switch (view.state) {
    case "declined":
      return buildCallbackPageHtml({
        kind: "error",
        title: "Already declined",
        message: `The request to run "${view.tool}" was declined. Nothing ran, and this decision is final.`,
      });
    case "consumed":
      return buildCallbackPageHtml({
        kind: "success",
        title: "Already approved",
        message: `The request to run "${view.tool}" was approved and has already been carried out. There is nothing left to decide.`,
      });
    default:
      return buildCallbackPageHtml({
        kind: "success",
        title: "Already approved",
        message: `The request to run "${view.tool}" was approved. The assistant will carry it out. You can close this tab.`,
      });
  }
}

export function registerToolApprovalRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── GET /v1/tool-approvals/decide?grant=skag_… ────────────────────────────
  // Unauthenticated browser-grant path. RESOLVES ONLY — does not decide.
  app.openapi(approvalPortalPageRoute, async (c) => {
    const db = c.get("db");
    const { grant } = c.req.valid("query");

    const view = await resolveApprovalPortalToken(db, grant);
    if (!view) {
      // Never echo the grant token, in HTML or in logs.
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.invalid_grant",
        msg: "approval grant not found or expired — a browser opened a dead link",
      });
      const { html, status } = buildCallbackPageHtml(LINK_DEAD_PAGE);
      return c.body(html, status, HTML_HEADERS);
    }

    if (view.state !== "pending") {
      const { html, status } = alreadyDecidedPage(view);
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
    return c.body(buildApprovalDecisionHtml(view, grant, approver, csrfToken), 200, HTML_HEADERS);
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

    if (!grant || (decision !== "approve" && decision !== "decline")) {
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Invalid approval submission",
        message:
          "This form was submitted without a valid link or decision. Nothing has been approved.",
      });
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
      const { html, status } = buildCallbackPageHtml(LINK_DEAD_PAGE);
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
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Sign in to decide",
        message:
          "Approving a write records who released it, so this decision needs a signed-in account. Open the approval link again and sign in — nothing has been approved.",
      });
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
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Could not verify this submission",
        message:
          "This decision form could not be verified as yours. Open the approval link again and decide from that page. Nothing has been approved.",
      });
      return c.body(html, status, HTML_HEADERS);
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
      const { html, status } = buildCallbackPageHtml({
        kind: "error",
        title: "Nothing to decide",
        message: `${DECISION_REFUSED_COPY[result.code]}\n\nNothing was changed by this submission.`,
      });
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

    // Say only what is true. A resumed conversation really will carry the call
    // out; an approval with no paused conversation (a direct tool dispatch, a
    // chat fast-path run, a relayed external-MCP call) is now merely CLAIMABLE,
    // and promising "the assistant will carry it out" there would invent a
    // completion no code performs.
    const { html, status } =
      decision === "approve"
        ? buildCallbackPageHtml({
            kind: "success",
            title: "Approved",
            message:
              completion.resumed > 0
                ? `"${result.tool}" is approved and is being carried out now. You can close this tab — the assistant reports back when it finishes.`
                : `"${result.tool}" is approved. The assistant can now carry it out; ask it to continue if it does not pick this up on its own. You can close this tab.`,
          })
        : buildCallbackPageHtml({
            kind: "success",
            title: "Declined",
            message: `"${result.tool}" was declined. Nothing ran, and nothing will. You can close this tab.`,
          });
    return c.body(html, status, HTML_HEADERS);
  });
}
