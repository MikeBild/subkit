// Canonical redirect URI for the interactive external-MCP-client OAuth 2.1
// flow.
//
// CRITICAL: the redirect_uri the pool's non-interactive DCR handshake
// registers MUST be byte-identical to the one the interactive authorize
// route hands the operator's browser. If they diverge, dynamic client
// registration registers one redirect_uri and the authorization request
// uses another → the IdP rejects with `redirect_uri_mismatch`. Both paths
// resolve through THIS module so the value can never drift.
//
// The MCP callback path is deliberately distinct from the connector
// callback (`/v1/oauth/callback`) so an operator can allowlist one URL per
// concern in their IdP. Origin resolution is reused from the connector
// flow (`buildOAuthRedirectUri`); only the path is swapped.

import { buildOAuthRedirectUri, type OAuthOriginHints } from "../../credentials/index.ts";

/** Distinct callback path for the interactive MCP-client OAuth flow — kept
 *  separate from the connector callback (`/v1/oauth/callback`) so an
 *  operator can allowlist one URL per concern in their IdP. */
export const MCP_OAUTH_CALLBACK_PATH = "/v1/connectors/mcp/oauth/callback";

/**
 * Build the canonical interactive-MCP-OAuth redirect URI off the engine's
 * public origin. Reuses the connector flow's origin resolution but swaps
 * the path for the MCP-specific callback so the two flows never collide,
 * and so the authorize route and the pool's DCR handshake always register
 * the SAME redirect_uri. Returns `null` when no public origin resolves —
 * the caller must surface a typed error instead of inventing a host.
 */
export function buildMcpOAuthRedirectUri(hints?: OAuthOriginHints): string | null {
  const connectorUri = buildOAuthRedirectUri(hints);
  if (!connectorUri) return null;
  const u = new URL(connectorUri);
  u.pathname = MCP_OAUTH_CALLBACK_PATH;
  return u.toString();
}
