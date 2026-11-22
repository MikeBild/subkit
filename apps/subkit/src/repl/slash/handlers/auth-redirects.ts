const AUTH_BANNERS: Readonly<Record<string, string>> = Object.freeze({
  login: "run 'subkit login' outside the REPL to re-authenticate",
  logout: "run 'subkit logout' outside the REPL to drop the active profile",
  tenant: "run 'subkit tenants [use <id>]' outside the REPL to switch tenants",
});

export function dispatchAuthRedirectSlash(name: string): string | undefined {
  return AUTH_BANNERS[name];
}
