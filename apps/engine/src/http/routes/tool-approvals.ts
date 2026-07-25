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
// AUTH. Deliberately reachable without an API key: the approver has a browser,
// not a token. Possession of the one-shot `skag_…` grant is the proof, exactly
// as `sksg_…` is for the credential-setup portal — the token is a sha256 digest
// at rest, bound to one approval, expiring with it. The grant is NOT an
// identity, so it grants nothing beyond deciding this one approval.
//
// WHO IS RECORDED AS THE APPROVER. `grantApproval` writes `actor_id` onto the
// APPROVAL_GRANTED row, and that actor must be the human. The MCP principal that
// REQUESTED the write is recorded on APPROVAL_REQUESTED and must never be
// attributed the decision. So the approver id comes only from an authenticated
// USER principal on this browser request, in this approval's tenant — an API key
// or a system account riding along resolves to null (an unidentified human), not
// to the machine that asked.
//
// WHAT IS NEVER RENDERED. `args_ciphertext`, the decrypted args, and the approval
// id in any copyable form. The write preview is scrubbed through the
// `SECRET_PATTERNS` dual contract before it reaches the browser — a resolved URL
// can carry a query-mode credential. The plaintext grant token appears only in
// the hidden `grant` field so the browser can round-trip it on submit.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import { buildCallbackPageHtml, escapeHtml } from "../../connectors/index.ts";
import { completeApprovalBackedElicitation } from "../../conversations/index.ts";
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
import { parseFormBody } from "./oauth/shared.ts";

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

/**
 * The human who decided, or null when we cannot name one.
 *
 * A user principal in THIS approval's tenant is the approver. Anything else —
 * an anonymous browser, an API key, a system account, a user from another
 * tenant — is null. Recording the requesting machine as the approver would
 * describe a decision nobody made.
 */
function portalApproverUserId(
  principal: ResolvedPrincipal | undefined,
  tenant_id: string,
): string | null {
  if (!principal) return null;
  if (principal.kind !== "user") return null;
  if (principal.tenant_id !== tenant_id) return null;
  return principal.id;
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
 */
function buildApprovalDecisionHtml(view: ApprovalPortalView, grant: string): string {
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
    <form method="POST" action="${APPROVAL_PORTAL_PATH}">
      <input type="hidden" name="grant" value="${escapeHtml(grant)}" />
      <div class="actions">
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
        <button class="decline" type="submit" name="decision" value="decline">Decline</button>
      </div>
    </form>`,
  );
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

    return c.body(buildApprovalDecisionHtml(view, grant), 200, HTML_HEADERS);
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

    // Tenant comes from the resolved row, never from the request. The approver
    // is the browser's human principal, if it has one.
    const granted_by_user_id = portalApproverUserId(c.get("principal"), view.tenant_id);

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
