import type { OpenAPIHono } from "@hono/zod-openapi";
import { CLI_LOGIN_SCOPE, TOKEN_EXCHANGE_GRANT_TYPE } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { AppEnv } from "../../openapi.ts";

function buildProtectedResourceDocument(resource: string, base: string, scopesSupported: string[]) {
  return {
    resource,
    authorization_servers: [base],
    scopes_supported: scopesSupported,
  };
}

export function registerOAuthDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/.well-known/oauth-protected-resource", (c) => {
    let base: string;
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      return c.json(
        buildProtectedResourceDocument(`${base}/mcp`, base, cfg.auth.mcp_oauth.scopes_supported),
      );
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    let base: string;
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      return c.json(
        buildProtectedResourceDocument(`${base}/mcp`, base, cfg.auth.mcp_oauth.scopes_supported),
      );
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
  });

  app.get("/.well-known/oauth-protected-resource/v1/identity/cli-session", (c) => {
    try {
      const cfg = getConfig();
      const base = cfg.server.public_base_url;
      return c.json(
        buildProtectedResourceDocument(`${base}/v1/identity/cli-session`, base, [CLI_LOGIN_SCOPE]),
      );
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    let base: string;
    let scopesSupported: string[];
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      scopesSupported = [...new Set([...cfg.auth.mcp_oauth.scopes_supported, CLI_LOGIN_SCOPE])];
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/v1/oauth/authorize`,
      token_endpoint: `${base}/v1/oauth/token`,
      registration_endpoint: `${base}/v1/oauth/register`,
      revocation_endpoint: `${base}/v1/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT_TYPE],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: scopesSupported,
    });
  });
}
