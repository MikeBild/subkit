// MCP OAuth 2.1 discovery endpoints: RFC 9728 and RFC 8414 .well-known handlers.
//
// Raw Hono handlers — .well-known paths cannot be expressed as @hono/zod-openapi routes.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { TOKEN_EXCHANGE_GRANT_TYPE } from "../../../auth/index.ts";
import { getConfig } from "../../../config/loader.ts";
import type { AppEnv } from "../../openapi.ts";

function buildProtectedResourceDocument(base: string, scopesSupported: string[]) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    scopes_supported: scopesSupported,
  };
}

export function registerOAuthDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  // ── RFC 9728 Protected Resource Metadata ─────────────────────────────────
  // Raw handler — .well-known paths are not expressible as zod-openapi routes.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    let base: string;
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      return c.json(buildProtectedResourceDocument(base, cfg.auth.mcp_oauth.scopes_supported));
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    let base: string;
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      return c.json(buildProtectedResourceDocument(base, cfg.auth.mcp_oauth.scopes_supported));
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
  });

  // ── RFC 8414 Authorization Server Metadata ─────────────────────────────────
  // Raw handler — .well-known paths are not expressible as zod-openapi routes.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    let base: string;
    let scopesSupported: string[];
    try {
      const cfg = getConfig();
      base = cfg.server.public_base_url;
      scopesSupported = cfg.auth.mcp_oauth.scopes_supported;
    } catch {
      return c.json({ error: "service_unavailable" }, 503);
    }
    // TODO(mcp-spec): MCP 2025-11-25 recommends (SHOULD) OAuth Client ID
    // Metadata Documents — HTTPS-URL client_ids resolved to a JSON metadata
    // doc — as the preferred registration mechanism (DCR is downgraded to a
    // backwards-compat MAY). To support it: advertise
    // `client_id_metadata_document_supported: true` here and have the
    // authorization endpoint fetch + validate URL-form client_ids
    // (client_id must equal the doc URL; validate redirect_uris; SSRF-guard
    // the fetch — block private/link-local ranges, no auto-redirect). Makes
    // subkit future-proof before claude.ai/Cursor move to CIMD.
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
