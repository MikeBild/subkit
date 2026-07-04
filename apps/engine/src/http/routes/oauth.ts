// MCP OAuth 2.1 authorization + resource server routes — barrel.
//
// Registered OUTSIDE requireAuth — these bootstrap the OAuth session.
// Implements:
//   GET  /.well-known/oauth-protected-resource        RFC 9728
//   GET  /.well-known/oauth-protected-resource/mcp    RFC 9728 (variant)
//   GET  /.well-known/oauth-authorization-server      RFC 8414
//   POST /v1/oauth/register                            RFC 7591 DCR
//   GET  /v1/oauth/authorize                           auth-code + PKCE S256
//   POST /v1/oauth/authorize/decision                  consent approve/deny
//   POST /v1/oauth/token                               token exchange (form-encoded)
//   POST /v1/oauth/revoke                              RFC 7009
//
// The .well-known and form-encoded token endpoints cannot be expressed cleanly
// via @hono/zod-openapi (non-standard paths, application/x-www-form-urlencoded
// body), so they are registered as raw Hono handlers with a brief note.
// Precedent: the raw /mcp mount in mcp/transports/streamable-http.ts.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { registerOAuthConsentRoutes } from "./oauth/consent.ts";
import { registerOAuthDcrRoutes } from "./oauth/dcr.ts";
import { registerOAuthDiscoveryRoutes } from "./oauth/discovery.ts";
import { registerOAuthTokenRoutes } from "./oauth/token.ts";

export function registerMcpOAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  registerOAuthDiscoveryRoutes(app);
  registerOAuthDcrRoutes(app);
  registerOAuthConsentRoutes(app);
  registerOAuthTokenRoutes(app);
}
