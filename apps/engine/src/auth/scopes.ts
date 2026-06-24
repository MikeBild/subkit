// Credential scopes — the marker/permission split.
//
// An API-key principal carries `scopes`. Most scopes are `resource:action`
// permissions (e.g. `connector:write`) that act as a CEILING: a key minted
// with those scopes may exercise only those permissions, narrowing even an
// admin-role key so the displayed scope equals the enforced scope.
//
// The `mcp:*` family is the exception. Those scopes do NOT bound permissions
// — they select an MCP catalog MODE (product / authoring / admin), consumed
// by `resolveMcpMode`. They must therefore be EXCLUDED from the credential
// ceiling, or an authoring/admin key (whose only scope is `mcp:authoring`)
// would be wrongly narrowed to nothing.
//
// The wildcard `*` scope asserts "no narrowing" — full role-derived access.
// It is the default minted scope (`identity/service.ts`) and the admin-key
// scope (`db/issue-admin-key.ts`), so it must be treated as no ceiling.

/** MCP mode markers — surfaced by `resolveMcpMode`, never a ceiling. */
export const MCP_ADMIN_SCOPE = "mcp:admin";
export const MCP_AUTHORING_SCOPE = "mcp:authoring";

/** Wildcard scope: the key asserts no narrowing (full role-derived access). */
export const WILDCARD_SCOPE = "*";

/** True when `scope` is an `mcp:*` mode marker rather than a `resource:action`
 *  permission. The whole family is excluded — not just the two mode-selecting
 *  markers above but also `mcp:read` and any future `mcp:*`. */
export function isMcpModeMarkerScope(scope: string): boolean {
  return scope.startsWith("mcp:");
}

/** True when `scope` participates in the credential ceiling — i.e. it is a
 *  real `resource:action` permission, not the wildcard and not an `mcp:*`
 *  mode marker. */
export function isCeilingScope(scope: string): boolean {
  return scope !== WILDCARD_SCOPE && !isMcpModeMarkerScope(scope);
}
