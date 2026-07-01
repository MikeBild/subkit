// `request_connector_reauth` — recovery affordance for a dead connector
// credential.
//
// When a connector's credential goes stale (OAuth refresh_token revoked,
// static API key rotated upstream, login lapsed), the connector is flagged
// `needs_reauth` and authed calls come back `health:auth_failed`. This tool
// turns that dead-end into a one-click fix:
//
//   - OAuth2 (authorization_code): mints a single-use grant URL
//     (skog_… token, 10-min TTL) that the operator can open in a browser.
//     The URL is presented verbatim on its own line — never wrapped in
//     markdown, never shortened. Opening it redirects to the provider
//     sign-in. The grant is single-use; if it expires, call this tool again.
//
//   - OAuth2 (client_credentials_json): performs the M2M token exchange
//     synchronously and returns {status:"reauthorized"} — no browser needed.
//
//   - Non-OAuth (basic/bearer/header/query): binds a re-issue draft and
//     collects the new secret via ask_user_form; rotates in place.
//
// Resolution:
//   - `connector_id` (uuid) takes precedence.
//   - `slug` resolves to the connector via the connectors list when
//     `connector_id` is omitted.
//   - both omitted ⇒ `invalid_input` asking for one.
//
// RBAC: `connector:write` on the target connector — the non-OAuth path stages
// a credential rotation, so this is a write-class affordance (resolution
// pattern still mirrors `call_connector`: resolveConversationPrincipal + can()).
//
// This is NOT a skill-gated tool: a broken credential can surface in any
// conversation, so the recovery path must always be reachable.

import { z } from "@hono/zod-openapi";
import { beginConnectorOAuthDance } from "../../connectors/oauth-start.ts";
import { mintOAuthStartGrantUrl } from "../../connectors/oauth-start-grant.ts";
import { buildReauthUrl } from "../../connectors/reauth.ts";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { buildOAuthRedirectUri } from "../../credentials/oauth2/redirect-uri.ts";
import { logger } from "../../logging/logger.ts";
import { hydrateDraftFromSavedConnector } from "../authoring-state/normalize.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const RequestConnectorReauthInput = z
  .object({
    connector_id: z
      .string()
      .uuid("connector_id must be a UUID")
      .optional()
      .describe("Exact connector id; takes precedence over slug."),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe("Connector slug; resolved to an id when connector_id is omitted."),
  })
  .openapi("RequestConnectorReauthToolInput");

function structuredError(
  error_code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    ok: false,
    error_code,
    message,
    ...extra,
  };
}

// ---- the tool --------------------------------------------------------------

export const requestConnectorReauthTool: ConversationTool = {
  name: "request_connector_reauth",
  description:
    "Repair a connector whose credential is dead — flagged `needs_reauth`, or a `call_connector`/`probe_connector` came back `health: auth_failed`. OAuth2 (authorization_code) connectors → mints a single-use sign-in link (expires ~10 min) to open in a browser. OAuth2 (client_credentials) → refreshes the token machine-side and returns `status: reauthorized`. Non-OAuth (basic/bearer/header/query) → starts an in-chat credential re-issue: loads the connector into a draft and collects the new secret via `ask_user_form`; rotates in place (same connector id, dependent workflows untouched) — no delete+recreate. Resolves by `connector_id` (uuid) or `slug`.",
  use_case:
    "A saved connector's credential was revoked or rotated upstream and calls now fail with auth_failed. For OAuth2 authorization-code connectors, request_connector_reauth returns a one-time URL to open in a browser; for client-credentials connectors it refreshes immediately; for non-OAuth it binds a re-issue draft so the next ask_user_form submission rotates the credential on the existing connector.",
  important_notes: [
    "Pass either `connector_id` (uuid) or `slug`; `connector_id` wins when both are given.",
    "OAuth2 (authorization_code) → returns `method: oauth2`, `reauth_url` (present the URL verbatim on its own line as a bare URL — no markdown, no shortening), `single_use: true`, `expires_at`. Opening the link redirects to the provider sign-in page. If the link expires, call this tool again.",
    "OAuth2 (client_credentials) → returns `method: oauth2`, `status: reauthorized` — no URL needed.",
    "Non-OAuth → returns `method: portal_setup`, `mode: credential_re_issue`, and stages a re-issue draft; follow with `ask_user_form(type: password, sensitive: true)` to collect the new secret and it rotates in place.",
    "Never paste the secret in chat — always collect it through `ask_user_form(type: password, sensitive: true)`.",
    "Requires `connector:write` on the connector (the non-OAuth path stages a credential rotation).",
  ],
  example_input: { slug: "digitalocean" },
  inputSchema: RequestConnectorReauthInput,
  // draft_write: the non-OAuth path calls ctx.setDraft to stage a credential
  // re-issue (same as probe_connector_draft / start_connector_*). The actual
  // credential write happens downstream through the elicitation → auto-persist
  // path, which carries its own gate.
  category: "draft_write",
  permission: {
    action: "connector:write",
    resourceType: "connector",
    resolveResourceId: async (ctx, rawArgs) => {
      if (rawArgs.connector_id) return String(rawArgs.connector_id);
      if (!rawArgs.slug) return null;
      const { rows } = await ctx.engineClient.connectors.list();
      const match = rows.find((c) => c.slug === rawArgs.slug);
      return match ? match.id : null;
    },
    denyResult: (permission, reason) =>
      structuredError("permission_denied", reason, { permission }),
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = RequestConnectorReauthInput.parse(rawArgs);

    if (!args.connector_id && !args.slug) {
      return structuredError(
        "invalid_input",
        "pass either `connector_id` (uuid) or `slug` to identify the connector to reconnect",
        { next_best_actions: ["find_connector", "list_connectors"] },
      );
    }

    // Resolve slug → id when connector_id is omitted.
    let connectorId = args.connector_id ?? null;
    if (!connectorId && args.slug) {
      const { rows: list } = await ctx.engineClient.connectors.list();
      const match = list.find((c) => c.slug === args.slug);
      if (!match) {
        return structuredError("connector_not_found", `no connector with slug '${args.slug}'`, {
          next_best_actions: ["find_connector", "list_connectors"],
        });
      }
      connectorId = match.id;
    }

    // Narrowed: the early guard above rejects the both-missing case, and slug
    // resolution either sets connectorId or returns. This makes connectorId a
    // plain string for the rest of the flow (no non-null assertions).
    if (!connectorId) {
      return structuredError(
        "invalid_input",
        "pass either `connector_id` (uuid) or `slug` to identify the connector to reconnect",
        { next_best_actions: ["find_connector", "list_connectors"] },
      );
    }

    // RBAC (`connector:write` on the target connector — the non-OAuth path
    // stages a credential rotation, so read is not enough) is enforced
    // centrally via the `permission` descriptor before execute runs; the
    // resolver mirrors the slug→id lookup above. See permission-gate.ts.

    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return structuredError("connector_not_found", `no connector with id '${connectorId}'`, {
        next_best_actions: ["find_connector", "list_connectors"],
      });
    }

    const { method } = buildReauthUrl(connector);

    // Resolve the OAuth grant type up front — it decides browser vs. machine
    // vs. in-chat re-issue.
    const oauthCfg = await resolveConnectorOAuthConfig(ctx.db, ctx.tenant_id, connector);
    const grantType = oauthCfg?.grant_type ?? null;

    // Cognito USER_PASSWORD_AUTH (`cognito_user_password`) is OAuth2-typed but
    // is NOT a browser authorization-code flow: the engine stores only the
    // refresh token + username — never the password. Once the refresh token
    // expires there is nothing to refresh and no authorization endpoint to
    // redirect to; issuing a browser grant link sends the user to the Cognito
    // InitiateAuth endpoint, where the dance throws "unexpected HTTP response
    // status code" (the grant is burned and the user sees a misleading
    // "link used up" page). The correct repair is the SAME in-chat re-issue
    // used for basic/bearer/etc.: re-collect email + password and re-mint.
    const needsInteractiveReissue =
      method === "portal_setup" || grantType === "cognito_user_password";

    // Non-OAuth (basic/bearer/header/query) connectors — and password grants
    // like Cognito USER_PASSWORD_AUTH — have no working click-through flow.
    // Repair IN CHAT: bind the saved connector into a re-issue draft, then have
    // the LLM collect the new secret via a masked `ask_user_form`. The
    // submission flows through the existing auto-persist re-issue path
    // (`saveConnectorAtomic` → `upsertCredential` → `clearConnectorReauth`),
    // rotating the credential on the SAME connector id — no delete+recreate,
    // no orphaned workflows.
    if (needsInteractiveReissue) {
      const isCognito = grantType === "cognito_user_password";
      // A `none`-auth connector has no credential to rotate.
      if (connector.auth_type === "none") {
        return structuredError(
          "no_credential_to_reissue",
          `connector '${connector.slug}' uses auth_type 'none' — there is no credential to re-issue. If it is failing, the base_url or upstream is the issue, not auth.`,
          { next_best_actions: ["probe_connector", "update_connector_draft"] },
        );
      }

      // D7: over MCP the in-chat `ask_user_form` credential re-issue is
      // NOT reachable — a secret must never be collected as chat text
      // there (see `ask-user/common.ts`). Route to the secure
      // credential-setup URL (`/v1/connectors/:id/credentials`) instead,
      // presented verbatim for the operator to open in a browser. On
      // sk-cli / web the masked in-chat form stays (a local operator may
      // paste the secret), so this branch is scoped to `surface === "mcp"`.
      if (ctx.surface === "mcp") {
        const { reauth_url } = buildReauthUrl(connector);
        if (!reauth_url) {
          return structuredError(
            "engine_public_url_missing",
            "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL so a secure credential-setup URL can be minted",
          );
        }
        logger.info({
          module: "conversation_tool",
          action: "request_connector_reauth.portal_setup_url_issued",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: connector.id,
          auth_type: connector.auth_type,
        });
        return {
          ok: true,
          data: {
            connector: connector.slug,
            method: "portal_setup",
            mode: "credential_re_issue",
            auth_type: connector.auth_type,
            ...(isCognito ? { grant_type: "cognito_user_password" } : {}),
            setup_url: reauth_url,
            needs_reauth: connector.needs_reauth,
            auth_failed_at: connector.auth_failed_at?.toISOString() ?? null,
            instructions:
              "Present this URL verbatim on its own line as a bare URL — no markdown wrapper, no shortening. " +
              "Opening it takes the user to a secure page to enter the new secret; it rotates in place on the " +
              "existing connector (the id and every dependent workflow stay intact). " +
              "Never ask the user to paste the secret in chat.",
          },
        };
      }

      const draftConnector = hydrateDraftFromSavedConnector(connector);
      const nextDraft = withConnectorDraft(
        ctx.getDraft(),
        draftConnector,
        "connector_reauth_started",
      );
      await ctx.setDraft(nextDraft);
      logger.info({
        module: "conversation_tool",
        action: "request_connector_reauth.reissue_draft_bound",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        auth_type: connector.auth_type,
      });
      return {
        ok: true,
        data: {
          connector: connector.slug,
          method: "portal_setup",
          mode: "credential_re_issue",
          auth_type: connector.auth_type,
          ...(isCognito ? { grant_type: "cognito_user_password" } : {}),
          needs_reauth: connector.needs_reauth,
          auth_failed_at: connector.auth_failed_at?.toISOString() ?? null,
          next_best_actions: ["ask_user_form"],
          next_prompt: isCognito
            ? `The Cognito refresh token for '${connector.slug}' has expired and the password is never stored, so it must be re-entered. Collect the Cognito email (field 'username') and password (field 'password') via a masked ask_user_form (the password field: type password, sensitive: true). The engine re-runs InitiateAuth (USER_PASSWORD_AUTH) and rotates the credential in place — the connector id and every workflow that uses it stay intact.`
            : `Collect the new ${connector.auth_type} secret for '${connector.slug}' via a masked ask_user_form (type: password, sensitive: true). It rotates in place on the existing connector — the id and every workflow that uses it stay intact.`,
          instructions:
            "Do not paste the secret in chat. Call ask_user_form(sensitive: true) to collect it; the harness persists it atomically onto the existing connector, clears needs_reauth, and re-probes.",
        },
      };
    }

    // Machine-to-machine (client_credentials_json): run the exchange
    // synchronously — no browser dance needed.
    if (grantType === "client_credentials_json") {
      const redirect_uri = buildOAuthRedirectUri();
      if (!redirect_uri) {
        return structuredError(
          "engine_public_url_missing",
          "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL",
        );
      }
      try {
        await beginConnectorOAuthDance({
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector_id: connector.id,
          actor_id: ctx.actor_id,
          redirect_uri,
        });
        logger.info({
          module: "conversation_tool",
          action: "request_connector_reauth.m2m_reauthorized",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: connector.id,
        });
        return {
          ok: true,
          data: {
            connector: connector.slug,
            method: "oauth2",
            status: "reauthorized",
            needs_reauth: connector.needs_reauth,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return structuredError("reauth_failed", message, {
          connector: connector.slug,
        });
      }
    }

    // Authorization-code OAuth2: mint a single-use grant URL (10-min TTL).
    const grantResult = await mintOAuthStartGrantUrl(ctx.db, {
      tenant_id: ctx.tenant_id,
      connector,
      actor_id: ctx.actor_id,
      ...(ctx.engineClient.context.actor_type
        ? { actor_type: ctx.engineClient.context.actor_type }
        : {}),
      grant_type: grantType,
    });

    if (!grantResult.ok) {
      if (grantResult.error === "engine_public_url_missing") {
        return structuredError(
          "engine_public_url_missing",
          "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL",
        );
      }
      // no_browser_flow — shouldn't reach here since we handled ccj above
      return structuredError("no_browser_flow", "connector does not use a browser OAuth flow");
    }

    logger.info({
      module: "conversation_tool",
      action: "request_connector_reauth.grant_issued",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: connector.id,
    });

    return {
      ok: true,
      data: {
        connector: connector.slug,
        method: "oauth2",
        reauth_url: grantResult.url,
        expires_at: grantResult.expires_at.toISOString(),
        single_use: true,
        instructions:
          "Present this URL verbatim on its own line as a bare URL — no markdown wrapper, no shortening, no angle brackets. " +
          "It is single-use and expires in approximately 10 minutes. " +
          "Opening it redirects the user to the provider sign-in page. " +
          "If the link expires before the user opens it, call request_connector_reauth again to get a fresh link.",
        needs_reauth: connector.needs_reauth,
        auth_failed_at: connector.auth_failed_at?.toISOString() ?? null,
      },
    };
  },
};
