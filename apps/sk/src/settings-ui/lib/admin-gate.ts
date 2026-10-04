const ADMIN_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  "audit:read",
  "api_key:write",
  "api_key:rotate",
  "api_key:revoke",
  "discovery:approve",
  "connector:promote",
  "system:restart",
]);

const ADMIN_ONLY_PREFIXES: readonly string[] = ["rbac:"];

export function isAdminFromPermissions(perms: readonly string[]): boolean {
  for (const p of perms) {
    if (ADMIN_ONLY_PERMISSIONS.has(p)) return true;
    for (const prefix of ADMIN_ONLY_PREFIXES) {
      if (p.startsWith(prefix)) return true;
    }
    if (p.startsWith("credential:") && p !== "credential:read") return true;
  }
  return false;
}
