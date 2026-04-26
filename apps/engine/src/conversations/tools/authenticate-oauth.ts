// authenticate_oauth — chat-driven OAuth2 authorization-code dance.
//
// Mirrors the existing MCP `authenticate` product tool
// (`apps/engine/src/mcp/tools/authenticate.ts`) but exposes the same
// capability inside the conversation loop so the agent can drive the
// flow from a connector-creation thread:
//
//   1. save_connector_draft (with template-bound OAuth config OR an
//      explicit credential.mode="oauth2" carrying client_id/secret)
//   2. authenticate_oauth({ connector_id, scopes? })
//   3. The CLI / portal opens `authorization_url` in the user's
//      browser. Callback hits /v1/connectors/:id/oauth/callback which
//      exchanges the code for tokens and persists them via
//      upsertCredential. The agent never sees raw tokens.
//
// The credential row is keyed on (tenant_id, connector_id, environment),
// so there is no user-supplied "credential name" — same auto-naming
// pattern as bearer/basic/header/query atomic save.

import { z } from "@hono/zod-openapi";
import { getConnector } from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { startAuthorizationCode } from "../../credentials/oauth2/client.ts";
import { connectorOauthStates } from "../../db/schema/index.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    connector_id: z
      .string()
      .uuid()
      .describe(
        "Saved connector to authorize. Falls back to the conversation's target_connector_id when omitted.",
      )
      .optional(),
    scopes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "OAuth scopes to request. When omitted, the connector template's default scopes apply.",
      ),
    return_url: z
      .string()
      .url()
      .optional()
      .describe("Optional URL to redirect the user back to after a successful authorization."),
  })
  .openapi("AuthenticateOAuthToolInput");

export const authenticateOAuthTool: ConversationTool = {
  name: "authenticate_oauth",
  description:
    "Start the OAuth2 authorization-code dance for a saved connector. Returns an authorization URL the user opens in a browser; tokens are persisted automatically when the callback completes. Never re-prompt the user for an access token in chat — that path is forbidden. Pair this with `save_connector_draft({ credential: { mode: 'oauth2', ... } })` for connectors with custom client_id/secret.",
  use_case:
    "After `save_connector_draft` for a connector whose template advertises `auth_type: oauth2` (or whose credential mode is `oauth2`), call this tool to obtain the authorization URL.",
  important_notes: [
    "Requires the connector to be saved (has an id in the connectors table). Use `save_connector_draft` first.",
    "The agent NEVER sees access tokens or refresh tokens — they are persisted server-side via the OAuth callback route.",
    "Reuses the existing /v1/connectors/:id/oauth/callback handler which calls `upsertCredential` on the way out.",
  ],
  inputSchema,
  category: "tenant_write",
  requires_skill: "oauth-flow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connectorId = args.connector_id ?? ctx.connector_id ?? null;
    if (!connectorId) {
      return {
        ok: false,
        data: {
          error: "no_saved_connector",
          message:
            "authenticate_oauth requires a saved connector id. Save the draft first with save_connector_draft.",
        },
      };
    }
    const connector = await getConnector(ctx.tenant_id, connectorId, ctx.db);
    if (!connector) {
      return {
        ok: false,
        data: {
          error: "connector_missing",
          message: `connector ${connectorId} was not found in this tenant.`,
        },
      };
    }
    const cfg = await resolveConnectorOAuthConfig(ctx.db, ctx.tenant_id, connector);
    if (!cfg) {
      return {
        ok: false,
        data: {
          error: "oauth_not_configured",
          message:
            "this connector is not configured for OAuth2 authentication. Either pick a template with OAuth or save the draft with credential.mode='oauth2'.",
        },
      };
    }
    if (!cfg.redirect_uri) {
      return {
        ok: false,
        data: {
          error: "redirect_uri_missing",
          message: "the connector's OAuth2 config is missing redirect_uri.",
        },
      };
    }
    const cfgWithScope =
      args.scopes && args.scopes.length > 0 ? { ...cfg, scope: args.scopes.join(" ") } : cfg;
    const started = await startAuthorizationCode(cfgWithScope);
    const expires = new Date(Date.now() + 10 * 60_000);
    await ctx.db.insert(connectorOauthStates).values({
      tenant_id: ctx.tenant_id,
      connector_id: connectorId,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri: cfgWithScope.redirect_uri ?? cfg.redirect_uri,
      expires_at: expires,
    });
    // The redacted config payload mirrors the MCP authenticate handler —
    // never echoes client_secret. Surfaced in the tool result so the CLI
    // can render a "open this URL to finish authentication" affordance
    // without a second round-trip.
    return {
      ok: true,
      data: {
        authorization_url: started.authorization_url,
        state: started.state,
        expires_at: expires.toISOString(),
        connector_id: connectorId,
        ...(args.return_url ? { return_url: args.return_url } : {}),
      },
    };
  },
};
