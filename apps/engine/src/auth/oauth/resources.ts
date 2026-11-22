export const CLI_LOGIN_SCOPE = "subkit:login" as const;

type OAuthResourceKind = "mcp" | "cli_login";

export function oauthResource(
  publicBaseUrl: string,
  requested: string | null | undefined,
): { kind: OAuthResourceKind; resource: string } | null {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const mcp = `${base}/mcp`;
  const cli = `${base}/v1/identity/cli-session`;
  const raw = (requested ?? "").replace(/\/+$/, "");
  if (!raw || raw === base || raw === mcp) return { kind: "mcp", resource: mcp };
  if (raw === cli) return { kind: "cli_login", resource: cli };
  return null;
}
