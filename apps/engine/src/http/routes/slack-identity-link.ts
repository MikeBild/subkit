import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { ResolvedPrincipal } from "../../auth/index.ts";
import {
  assertChatWorkspaceOwnershipAvailable,
  ChatIdentityLinkRefusedError,
  linkChatIdentity,
  SLACK_LINK_PATH,
  type SlackLinkClaims,
  verifySlackLinkToken,
} from "../../chat/index.ts";
import { getConfig } from "../../config/index.ts";
import type { Db } from "../../db/index.ts";
import { logger } from "../../logging/index.ts";
import { findActiveApproverEmail } from "../../tools/index.ts";
import { slackDecisionCopy } from "../i18n/slack-decisions.ts";
import type { AppEnv } from "../openapi.ts";
import { redirectToSignIn } from "./browser-sign-in.ts";
import {
  deriveSessionSecret,
  escapeHtml,
  resolveSession,
  sessionIsLive,
  signCsrfToken,
  verifyCsrfToken,
} from "./oauth/shared.ts";
import {
  cockpitLink,
  HTML_PAGE_HEADERS,
  type PageLook,
  pageActions,
  pageHead,
  renderSinglePage,
  resolvePageLook,
} from "./oauth/ui.ts";

const LinkQuery = z.object({ token: z.string().max(4096).default("") }).openapi("SlackLinkQuery");
const LinkForm = z
  .object({ token: z.string().max(4096).default(""), csrf_token: z.string().max(4096).default("") })
  .openapi("SlackLinkForm");
const Html = { "text/html": { schema: z.string() } };

const linkPageRoute = createRoute({
  method: "get",
  path: SLACK_LINK_PATH,
  tags: ["chat"],
  summary: "Browser page that links the clicking Slack account to the signed-in SubKit person",
  description:
    "Opened from the one-time link in a Slack decision message. Requires a signed-in Cockpit session in the same workspace; shows which Slack account will be linked and asks for confirmation.",
  request: { query: LinkQuery },
  responses: {
    200: { description: "Confirmation page (HTML)", content: Html },
    302: { description: "Not signed in: redirect to sign-in and back" },
    400: { description: "Link expired, invalid or for another workspace (HTML)", content: Html },
  },
});

const linkConfirmRoute = createRoute({
  method: "post",
  path: SLACK_LINK_PATH,
  tags: ["chat"],
  summary: "Confirm the Slack account link for the signed-in SubKit person",
  request: {
    body: {
      content: { "application/x-www-form-urlencoded": { schema: LinkForm } },
      required: true,
    },
  },
  responses: {
    200: { description: "Linked (HTML)", content: Html },
    400: { description: "Link refused; nothing changed (HTML)", content: Html },
  },
});

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function page(look: PageLook, body: string): string {
  return renderSinglePage({
    look,
    surface: "auth",
    context: slackDecisionCopy(look.locale).page.context,
    body,
  });
}

function statusPage(look: PageLook, title: string, line: string, status: 200 | 400) {
  return {
    html: page(
      look,
      `${pageHead({ title, slot: "auth-heading", line })}${pageActions(cockpitLink(look.locale))}`,
    ),
    status,
  };
}

interface LinkSession {
  session_id: string;
  user_id: string;
  tenant_id: string;
}

async function liveSession(req: Request, db: Db, tenant_id: string): Promise<LinkSession | null> {
  const session = await resolveSession(req);
  if (!session || session.tenant_id !== tenant_id) return null;
  if (!(await sessionIsLive(db, session.session_id, session.tenant_id))) return null;
  return { session_id: session.session_id, user_id: session.user_id, tenant_id: session.tenant_id };
}

function confirmHtml(
  look: PageLook,
  claims: SlackLinkClaims,
  email: string,
  token: string,
  csrf: string,
): string {
  const copy = slackDecisionCopy(look.locale).page;
  const form = `<form method="post" action="${escapeHtml(SLACK_LINK_PATH)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><button class="button primary" type="submit" data-testid="slack-link-confirm">${escapeHtml(copy.confirm)}</button></form>`;
  return page(
    look,
    `${pageHead({ title: copy.title, slot: "auth-heading", line: copy.line(claims.slack_user_id, claims.team_id, email) })}${pageActions(form)}`,
  );
}

function principalOf(session: LinkSession): ResolvedPrincipal {
  return {
    provider: "session",
    kind: "user",
    id: session.user_id,
    tenant_id: session.tenant_id,
    roles: [],
    session_id: session.session_id,
  };
}

export function registerSlackIdentityLinkRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(linkPageRoute, async (c) => {
    const db = c.get("db");
    const look = resolvePageLook(c.req.raw.headers);
    const copy = slackDecisionCopy(look.locale).page;
    const { token } = c.req.valid("query");
    const claims = await verifySlackLinkToken(token);
    if (!claims) {
      const { html, status } = statusPage(look, copy.deadTitle, copy.deadLine, 400);
      return c.body(html, status, HTML_PAGE_HEADERS);
    }
    const session = await liveSession(c.req.raw, db, claims.tenant_id);
    if (!session)
      return (await redirectToSignIn(
        SLACK_LINK_PATH,
        { token },
        getConfig().server.public_base_url || new URL(c.req.url).origin,
        c.req.path,
      )) as never;
    const email = await findActiveApproverEmail(db, session.tenant_id, session.user_id);
    if (!email) {
      const { html, status } = statusPage(look, copy.refusedTitle, copy.refusedLine, 400);
      return c.body(html, status, HTML_PAGE_HEADERS);
    }
    const csrf = await signCsrfToken(deriveSessionSecret(), {
      session_id: session.session_id,
      token_sha256: tokenDigest(token),
    });
    return c.body(confirmHtml(look, claims, email, token, csrf), 200, HTML_PAGE_HEADERS);
  });

  app.openapi(linkConfirmRoute, async (c) => {
    const db = c.get("db");
    const look = resolvePageLook(c.req.raw.headers);
    const copy = slackDecisionCopy(look.locale).page;
    const form = c.req.valid("form");
    const refused = () => {
      const { html, status } = statusPage(look, copy.refusedTitle, copy.refusedLine, 400);
      return c.body(html, status, HTML_PAGE_HEADERS);
    };
    const claims = await verifySlackLinkToken(form.token);
    if (!claims) {
      const { html, status } = statusPage(look, copy.deadTitle, copy.deadLine, 400);
      return c.body(html, status, HTML_PAGE_HEADERS);
    }
    const session = await liveSession(c.req.raw, db, claims.tenant_id);
    const csrf = await verifyCsrfToken(deriveSessionSecret(), form.csrf_token);
    if (
      !session ||
      !csrf ||
      csrf.session_id !== session.session_id ||
      csrf.token_sha256 !== tokenDigest(form.token) ||
      !(await findActiveApproverEmail(db, session.tenant_id, session.user_id))
    ) {
      logger.warn({
        module: "chat",
        action: "slack.identity_link.refused",
        msg: "a Slack account link was submitted without a matching session or CSRF token",
        tenant_id: claims.tenant_id,
      });
      return refused();
    }
    try {
      await assertChatWorkspaceOwnershipAvailable(db, session.tenant_id);
      await linkChatIdentity(db, {
        principal: principalOf(session),
        kind: "self",
        body: {
          user_id: session.user_id,
          platform: "slack",
          workspace_id: claims.team_id,
          platform_user_id: claims.slack_user_id,
        },
      });
    } catch (error) {
      if (error instanceof ChatIdentityLinkRefusedError && error.refusal === "already_linked") {
        const { html, status } = statusPage(look, copy.alreadyTitle, copy.alreadyLine, 400);
        return c.body(html, status, HTML_PAGE_HEADERS);
      }
      logger.warn({
        module: "chat",
        action: "slack.identity_link.failed",
        msg: "a Slack account link was refused",
        tenant_id: session.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return refused();
    }
    const { html, status } = statusPage(look, copy.linkedTitle, copy.linkedLine, 200);
    return c.body(html, status, HTML_PAGE_HEADERS);
  });
}
