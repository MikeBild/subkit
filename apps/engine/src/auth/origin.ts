import type { ResolvedPrincipal } from "./types.ts";

export function principalOrigin(p: ResolvedPrincipal): string | null {
  if (p.api_key_id) return `api_key:${p.api_key_id}`;
  if (p.oauth_client_id) return `mcp_oauth:${p.oauth_client_id}`;
  if (p.session_id) return `${p.provider}:session`;
  return null;
}
