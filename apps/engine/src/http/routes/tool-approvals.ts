import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cockpitInstallationIdFromPath, signLoginState } from "../../auth/index.ts";
import { getConfig } from "../../config/loader.ts";
import { completeApprovalBackedElicitation } from "../../conversations/public/authoring.ts";
import {
  type TaskRunApprovalRefusal,
  taskRunApprovalRefusal,
} from "../../conversations/public/lifecycle.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { enqueueApprovalElicitationResume, getBoss } from "../../queue/index.ts";
import {
  APPROVAL_PORTAL_PATH,
  declineApproval,
  findActiveApproverEmail,
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
import { localeCookie, resolvePageLook } from "./oauth/ui.ts";
import { approvalCopy, approvalDenialCopy } from "./tool-approval-copy.ts";
import {
  alreadyDecidedPage,
  approvalStatusPage,
  buildApprovalDecisionHtml,
} from "./tool-approval-ui.ts";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicBaseUrl(): string {
  return getConfig().server.public_base_url;
}

function servedOverHttps(requestUrl: string): boolean {
  return new URL(publicBaseUrl() || requestUrl).protocol === "https:";
}

const ApprovalGrantQuery = z
  .object({ grant: z.string().default("") })
  .openapi("ApprovalGrantQuery");

const approvalPortalPageRoute = createRoute({
  method: "get",
  path: APPROVAL_PORTAL_PATH,
  tags: ["tool-approvals"],
  summary: "Browser-openable approval portal (single-use grant token)",
  request: { query: ApprovalGrantQuery },
  responses: {
    200: { description: "OK (HTML)", content: { "text/html": { schema: z.string() } } },
    400: {
      description: "Grant invalid/expired (HTML error page)",
      content: { "text/html": { schema: z.string() } },
    },
  },
});

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

interface ApprovalApprover {
  user_id: string;
  session_id: string;
  email: string;
}

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
    const email = await findActiveApproverEmail(db, tenant_id, session.user_id);
    if (email === null) return null;
    return {
      user_id: session.user_id,
      session_id: session.session_id,
      email,
    };
  }

  return null;
}

async function redirectToSignIn(
  grant: string,
  publicBaseUrl: string,
  requestPath: string,
): Promise<Response> {
  const installationId = cockpitInstallationIdFromPath(requestPath);
  const apiPrefix = installationId ? `/cockpit/i/${installationId}/api` : "";
  const back = new URL(`${apiPrefix}${APPROVAL_PORTAL_PATH}`, publicBaseUrl);
  back.searchParams.set("grant", grant);
  const loginUrl = new URL(
    installationId ? `${apiPrefix}/v1/identity/cockpit-login` : "/v1/identity/login/start",
    publicBaseUrl,
  );
  if (installationId) loginUrl.searchParams.set("return_to", `${back.pathname}${back.search}`);
  else
    loginUrl.searchParams.set(
      "login_state",
      await signLoginState({ redirect_to: back.toString() }),
    );
  return Response.redirect(loginUrl.toString(), 302);
}

function taskRunRefusalCopy(refusal: TaskRunApprovalRefusal, locale: string): string {
  if (refusal === "owner_only")
    return locale === "de"
      ? "Nur die Besitzerin der Aufgabe kann diese Freigabe erteilen."
      : "Only the owner of the task can give this approval.";
  return locale === "de"
    ? "Nur die Person, die das angefragt hat, oder ein Admin kann das entscheiden."
    : "Only the person who asked for this or an admin can decide this.";
}

export function registerToolApprovalRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(approvalPortalPageRoute, async (c) => {
    const db = c.get("db");
    const { grant } = c.req.valid("query");
    const look = resolvePageLook(c.req.raw.headers);
    const copy = approvalCopy(look.locale);

    const view = await resolveApprovalPortalToken(db, grant);
    if (!view) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.invalid_grant",
        msg: "approval grant not found or expired — a browser opened a dead link",
      });
      const { html, status } = approvalStatusPage(look, copy.deadTitle, copy.deadMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    if (view.state !== "pending") {
      const { html, status } = alreadyDecidedPage(view, look);
      return c.body(html, status, HTML_HEADERS);
    }

    const approver = await resolveApprovalApprover(c, db, view.tenant_id);
    if (!approver) {
      return await redirectToSignIn(grant, publicBaseUrl(), c.req.path);
    }
    const refusal = await taskRunApprovalRefusal(db, {
      tenant_id: view.tenant_id,
      approval_id: view.approval_id,
      user_id: approver.user_id,
    });
    if (refusal) {
      const { html, status } = approvalStatusPage(
        look,
        copy.refusedTitle,
        taskRunRefusalCopy(refusal, look.locale),
      );
      return c.body(html, status, HTML_HEADERS);
    }

    const csrfToken = await signCsrfToken(deriveSessionSecret(), {
      session_id: approver.session_id,
      grant_sha256: sha256Hex(grant),
    });
    return c.body(
      buildApprovalDecisionHtml(view, grant, approver, csrfToken, look, c.req.path),
      200,
      HTML_HEADERS,
    );
  });

  app.post(APPROVAL_PORTAL_PATH, async (c) => {
    const db = c.get("db");
    const form = await parseFormBody(c.req.raw);
    const grant = form.get("grant") ?? "";
    const decision = form.get("decision") ?? "";
    const language = z.enum(["de", "en"]).safeParse(form.get("language"));
    const requested = resolvePageLook(c.req.raw.headers);
    const look = language.success ? { ...requested, locale: language.data } : requested;
    const copy = approvalCopy(look.locale);

    if (
      !grant ||
      (decision !== "approve" && decision !== "decline" && !(decision === "" && language.success))
    ) {
      const { html, status } = approvalStatusPage(look, copy.invalidTitle, copy.invalidMessage);
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
      const { html, status } = approvalStatusPage(look, copy.deadTitle, copy.deadMessage);
      return c.body(html, status, HTML_HEADERS);
    }

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
      const { html, status } = approvalStatusPage(look, copy.signTitle, copy.signMessage);
      return c.body(html, status, HTML_HEADERS);
    }
    const granted_by_user_id = approver.user_id;

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
      const { html, status } = approvalStatusPage(look, copy.csrfTitle, copy.csrfMessage);
      return c.body(html, status, HTML_HEADERS);
    }

    if (decision === "") {
      const remembered = {
        ...HTML_HEADERS,
        "set-cookie": localeCookie(look.locale, servedOverHttps(c.req.url)),
      };
      if (view.state !== "pending") {
        const { html, status } = alreadyDecidedPage(view, look);
        return c.body(html, status, remembered);
      }
      return c.body(
        buildApprovalDecisionHtml(
          view,
          grant,
          approver,
          form.get("csrf_token") ?? "",
          look,
          c.req.path,
        ),
        200,
        remembered,
      );
    }

    const refusal = await taskRunApprovalRefusal(db, {
      tenant_id: view.tenant_id,
      approval_id: view.approval_id,
      user_id: granted_by_user_id,
    });
    if (refusal) {
      logger.warn({
        module: "tool_approvals",
        action: "approval.portal.task_run_approver_refused",
        msg: "a person who may not decide this approval tried to decide it",
        refusal,
        approval_id: view.approval_id,
        tenant_id: view.tenant_id,
        user_id: granted_by_user_id,
        decision,
      });
      const { html, status } = approvalStatusPage(
        look,
        copy.refusedTitle,
        `${taskRunRefusalCopy(refusal, look.locale)} ${copy.unchanged}`,
      );
      return c.body(html, status, HTML_HEADERS);
    }

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
        look,
        result.code === "approval_expired"
          ? look.locale === "de"
            ? "Frist abgelaufen"
            : "Deadline expired"
          : copy.refusedTitle,
        `${approvalDenialCopy(result.code, look.locale)} ${copy.unchanged}`,
      );
      return c.body(html, status, HTML_HEADERS);
    }

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

    const { html, status } =
      decision === "approve"
        ? approvalStatusPage(
            look,
            copy.approvedTitle,
            completion.resumed > 0 ? copy.queuedMessage : copy.approvedMessage,
            200,
          )
        : approvalStatusPage(look, copy.declinedTitle, copy.declinedMessage, 200);
    return c.body(html, status, HTML_HEADERS);
  });
}
