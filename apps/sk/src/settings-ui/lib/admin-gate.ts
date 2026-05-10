// Single source of truth for the Admin-tab visibility gate.
//
// Server-side RBAC enforces every Admin mutation independently; this
// gate is purely a UX filter so non-admins don't see a tab they can't
// use.
//
// W3 + S2 of PR #161 review (round 2): narrowed from the previous
// over-liberal set ({rbac:read, api_key:read, audit:read,
// identity:read, portal_token:read}) which was member-scoped and
// surfaced the Admin tab to every tenant member.
//
// W4 + S5 of PR #161 review (round 4): widened to mirror the engine's
// `memberPermissionFilter` deny-list at `apps/engine/src/rbac/seed.ts:48`.
// The earlier four-permission probe missed admin-class permissions
// like `api_key:rotate` / `api_key:revoke` / `credential:write` /
// `rbac:write`, so a principal granted only those would still see the
// Admin tab hidden — server-side RBAC enforced, but the UX cliff was
// real. Both checks below are exact matches OR prefix matches that
// follow the engine's deny-list shape.
//
// **Stay in lockstep:** every entry/prefix below MUST mirror an
// exclusion in `apps/engine/src/rbac/seed.ts:memberPermissionFilter`.
// The `admin-gate.test.ts` suite has explicit regression cases for
// each prefix and exact match. If you change either side, update
// the other and the test in the same commit.

const ADMIN_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  "audit:read",
  "api_key:write",
  "api_key:rotate",
  "api_key:revoke",
  "discovery:approve",
]);

/**
 * Permissions starting with one of these prefixes are admin-only.
 * Mirrors the prefix-based excludes in `memberPermissionFilter`:
 * `rbac:*` (any verb) and `credential:*` except `credential:read`.
 */
const ADMIN_ONLY_PREFIXES: readonly string[] = ["rbac:"];

/**
 * Returns true when the principal holds at least one permission that
 * the built-in `member` role does not. Used to decide whether the
 * `Admin` tab is visible in the `/settings` palette.
 */
export function isAdminFromPermissions(perms: readonly string[]): boolean {
  for (const p of perms) {
    if (ADMIN_ONLY_PERMISSIONS.has(p)) return true;
    for (const prefix of ADMIN_ONLY_PREFIXES) {
      if (p.startsWith(prefix)) return true;
    }
    // `credential:*` except `credential:read` is admin-only.
    if (p.startsWith("credential:") && p !== "credential:read") return true;
  }
  return false;
}
