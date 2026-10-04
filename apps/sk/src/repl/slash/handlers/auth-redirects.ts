const AUTH_BANNERS: Readonly<Record<string, string>> = Object.freeze({
  login: "run 'sk login' outside the REPL to re-authenticate",
  logout: "run 'sk logout' outside the REPL to drop the active profile",
  tenant: "run 'sk tenants [use <id>]' outside the REPL to switch tenants",
});

export function dispatchAuthRedirectSlash(name: string): string | undefined {
  return AUTH_BANNERS[name];
}
