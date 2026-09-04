// Canonical OAuth protected resources owned by the SubKit authorization
// server. Keeping this outside the HTTP layer lets both route validation and
// resource-server credential consumption use one exact audience definition.

export const CLI_LOGIN_SCOPE = "sk:login" as const;

export type OAuthResourceKind = "mcp" | "cli_login";

export function oauthResource(
  publicBaseUrl: string,
  requested: string | null | undefined,
): { kind: OAuthResourceKind; resource: string } | null {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const mcp = `${base}/mcp`;
  const cli = `${base}/v1/identity/cli-session`;
  const raw = (requested ?? "").replace(/\/+$/, "");
  // Compatibility for clients that use the authorization-server origin as
  // the resource indicator: persist the exact MCP resource so the resource
  // server's audience check and the authorization endpoint cannot disagree.
  if (!raw || raw === base || raw === mcp) return { kind: "mcp", resource: mcp };
  if (raw === cli) return { kind: "cli_login", resource: cli };
  return null;
}
