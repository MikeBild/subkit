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

/**
 * The read-only scope that gates `GET /metrics`.
 *
 * Defined here rather than beside the OAuth consent screen because both the
 * transport (`http/routes/oauth/*`) and the configuration loader need it, and
 * the loader must not import a route module.
 */
export const METRICS_SCOPE = "metrics:read";

/**
 * Scopes the MCP authorization server ALWAYS advertises, whatever the stored
 * configuration says.
 *
 * `auth.mcp_oauth.scopes_supported` is a configurable leaf, and a running
 * installation does not ride the schema default: its settings document holds
 * an explicit list, persisted by an earlier settings write. So 6.33.0 extended
 * the default, every test that read the default passed, and production kept
 * serving the three scopes its document was pinned to — `metrics:read` was
 * absent from discovery, and a person connecting a monitoring system had no
 * box to tick. Measured on the droplet 2026-09-04, engine reporting 6.33.0.
 *
 * A scope that a route ENFORCES must be one a person can be OFFERED, or the
 * route is closed to connections by construction. That is not a preference an
 * installation gets to configure away, so the list below is unioned into the
 * configured value every time a configuration document becomes the running
 * config (`config/loader.ts`). Operators may still add scopes, reorder them,
 * and remove any scope that is not on this list.
 */
export const NON_REMOVABLE_MCP_SCOPES: readonly string[] = [METRICS_SCOPE];

/**
 * The configured advertisement plus whatever it may not drop, order preserved
 * and duplicates removed. Pure — the caller decides where it lands.
 */
export function withNonRemovableScopes(configured: readonly string[]): string[] {
  const merged = [...configured];
  for (const scope of NON_REMOVABLE_MCP_SCOPES) {
    if (!merged.includes(scope)) merged.push(scope);
  }
  return [...new Set(merged)];
}
