// Auth-tier slashes that redirect to the out-of-REPL `sk login` /
// `sk logout` / `sk tenants` CLI commands. Extracted from
// handler.ts (R7-S2 review fix) to keep the main switch focused
// on interactive multi-step flows.
//
// `/profile` is intentionally NOT here — it has live in-REPL behavior
// (list / switch profile via `ctx.switchProfile`) and stays in
// handler.ts.
//
// Returns:
//   - `string` if the command was handled
//   - `undefined` if the name doesn't belong to this group

const AUTH_BANNERS: Readonly<Record<string, string>> = Object.freeze({
  login: "run 'sk login' outside the REPL to re-authenticate",
  logout: "run 'sk logout' outside the REPL to drop the active profile",
  tenant: "run 'sk tenants [use <id>]' outside the REPL to switch tenants",
});

export function dispatchAuthRedirectSlash(name: string): string | undefined {
  return AUTH_BANNERS[name];
}
