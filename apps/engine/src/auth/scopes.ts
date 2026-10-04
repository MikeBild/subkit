export const MCP_ADMIN_SCOPE = "mcp:admin";
export const MCP_AUTHORING_SCOPE = "mcp:authoring";

export const WILDCARD_SCOPE = "*";

export function isMcpModeMarkerScope(scope: string): boolean {
  return scope.startsWith("mcp:");
}

export function isCeilingScope(scope: string): boolean {
  return scope !== WILDCARD_SCOPE && !isMcpModeMarkerScope(scope);
}

export const METRICS_SCOPE = "metrics:read";

export const NON_REMOVABLE_MCP_SCOPES: readonly string[] = [METRICS_SCOPE];

export function withNonRemovableScopes(configured: readonly string[]): string[] {
  const merged = [...configured];
  for (const scope of NON_REMOVABLE_MCP_SCOPES) {
    if (!merged.includes(scope)) merged.push(scope);
  }
  return [...new Set(merged)];
}
