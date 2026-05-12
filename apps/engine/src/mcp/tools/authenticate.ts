// MCP `authenticate` product tool.
//
// Visible in every MCP mode (product / authoring / admin) so clients can
// request a reauthentication link for a connector without discovering
// separate endpoints. Returns an authorization URL the user can open to
// re-authenticate.
//
// Scopes:
//   • "connector"  — reauth for a specific connector (OAuth2 authorize URL)
//   • "session"    — generic reauthentication URL (today: same as connector
//                    when connector_id is given, otherwise returns a hint
//                    that the caller must supply connector_id)
//
// The call writes the OAuth PKCE state to `connector_oauth_states` so the
// subsequent `/v1/oauth/callback` roundtrip can complete.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as connectorSvc from "../../connectors/service.ts";
import { resolveConnectorOAuthConfig } from "../../connectors/template-binding.ts";
import { startAuthorizationCode } from "../../credentials/oauth2/client.ts";
import { buildOAuthRedirectUri } from "../../credentials/oauth2/redirect-uri.ts";
import type { Db } from "../../db/client.ts";
import { connectorOauthStates } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";

export const AUTHENTICATE_TOOL_NAME = "authenticate";

export const authenticateTool: Tool = {
  name: AUTHENTICATE_TOOL_NAME,
  description:
    "Request a reauthentication link for a connector or the session. Returns an authorization URL the user opens in a browser to (re)approve access.",
  inputSchema: {
    type: "object",
    properties: {
      connector_id: {
        type: "string",
        description: "Connector to reauthenticate. Required for scope='connector'.",
      },
      scope: {
        type: "string",
        enum: ["session", "connector"],
        description: "`connector` reauths one integration; `session` reauths the user.",
        default: "connector",
      },
      return_url: {
        type: "string",
        description: "Optional: URL the portal should redirect to after auth succeeds.",
      },
    },
    additionalProperties: false,
  },
};

export interface AuthenticateArgs {
  connector_id?: string;
  scope?: "session" | "connector";
  return_url?: string;
}

export interface AuthenticateResult {
  portal_url: string;
  expires_at: string;
  state: string;
  /** Canonical OAuth callback URL the operator must add to their OAuth
   *  provider's allowlist. Same value for every OAuth2 connector on
   *  this engine — `${public_base_url}/v1/oauth/callback`. */
  redirect_uri: string;
}

export interface AuthenticateContext {
  db: Db;
  principal: ResolvedPrincipal;
}

export async function handleAuthenticate(
  ctx: AuthenticateContext,
  args: AuthenticateArgs,
): Promise<
  { ok: true; data: AuthenticateResult } | { ok: false; data: { error: string; reason?: string } }
> {
  const { db, principal } = ctx;
  const scope = args.scope ?? "connector";

  if (!args.connector_id) {
    // The session-scope case currently requires a connector because subkit
    // does not issue portal URLs outside a connector OAuth flow yet.
    // Session-level reauth is a follow-up.
    return {
      ok: false,
      data: {
        error: "connector_id is required for reauthentication",
        reason: "missing_connector_id",
      },
    };
  }

  const connector = await connectorSvc.getConnector(principal.tenant_id, args.connector_id, db);
  if (!connector) {
    return { ok: false, data: { error: "connector not found", reason: "connector_missing" } };
  }

  const oauthCfg = await resolveConnectorOAuthConfig(db, principal.tenant_id, connector);
  if (!oauthCfg) {
    return {
      ok: false,
      data: {
        error: "connector is not configured for OAuth2 authentication",
        reason: "oauth_not_configured",
      },
    };
  }

  const redirect_uri = buildOAuthRedirectUri();
  if (!redirect_uri) {
    return {
      ok: false,
      data: {
        error:
          "engine has no resolvable public origin — set server.public_base_url or SUBKIT_PUBLIC_BASE_URL before running an OAuth2 flow",
        reason: "engine_public_url_missing",
      },
    };
  }

  try {
    const started = await startAuthorizationCode({ ...oauthCfg, redirect_uri });
    const expires = new Date(Date.now() + 10 * 60_000);
    await db.insert(connectorOauthStates).values({
      tenant_id: principal.tenant_id,
      connector_id: args.connector_id,
      state: started.state,
      code_verifier: started.code_verifier,
      redirect_uri,
      expires_at: expires,
    });
    logger.info({
      module: "mcp",
      action: "mcp.authenticate.started",
      msg: "authenticate tool produced authorization URL",
      connector_id: args.connector_id,
      tenant_id: principal.tenant_id,
      scope,
    });
    return {
      ok: true,
      data: {
        portal_url: started.authorization_url,
        expires_at: expires.toISOString(),
        state: started.state,
        redirect_uri,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      data: { error: `authorize_url_failed: ${msg}`, reason: "authorize_failed" },
    };
  }
}
