import { buildOAuthRedirectUri, type OAuthOriginHints } from "../../credentials/index.ts";

export const MCP_OAUTH_CALLBACK_PATH = "/v1/connectors/mcp/oauth/callback";

export function buildMcpOAuthRedirectUri(hints?: OAuthOriginHints): string | null {
  const connectorUri = buildOAuthRedirectUri(hints);
  if (!connectorUri) return null;
  const u = new URL(connectorUri);
  u.pathname = MCP_OAUTH_CALLBACK_PATH;
  return u.toString();
}
