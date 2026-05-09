// Single source of truth for the Admin-tab visibility gate.
//
// Server-side RBAC enforces every Admin mutation independently; this
// gate is purely a UX filter so non-admins don't see a tab they can't
// use. The narrow set is permissions the built-in `member` role
// is *guaranteed not* to have (per `apps/engine/src/rbac/seed.ts`):
// `member` is the catch-all "tenant member" role and includes reads
// on api_key, identity, portal_token, knowledge, etc. — those are
// NOT admin-only.
//
// W3 + S2 of PR #161 review (round 2): narrowed from the previous
// over-liberal set ({rbac:read, api_key:read, audit:read,
// identity:read, portal_token:read}) which was member-scoped and
// surfaced the Admin tab to every tenant member. The
// SettingsApp + SettingsPane both consume this single helper.

const ADMIN_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  "rbac:read",
  "audit:read",
  "api_key:write",
  "discovery:approve",
]);

/**
 * Returns true when the principal holds at least one permission that
 * the built-in `member` role does not. Used to decide whether the
 * `Admin` tab is visible in the `/settings` palette.
 */
export function isAdminFromPermissions(perms: readonly string[]): boolean {
  for (const p of perms) {
    if (ADMIN_ONLY_PERMISSIONS.has(p)) return true;
  }
  return false;
}
