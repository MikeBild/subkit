// Seed the RBAC permission catalog + built-in roles.
//
// Runs as part of the tenant bootstrap (see `db/seed.ts`) and also
// on demand from any test harness that needs a tenant with live
// RBAC rows (see `tests/journeys/setup.ts`).
//
// Idempotent:
//   - `permissions` rows are upserted by `name`.
//   - Built-in roles are upserted by `(tenant_id IS NULL, name)`.
//   - `role_permissions` rows are inserted with ON CONFLICT DO NOTHING.
//
// The function also back-fills `users.role_id` + `system_accounts.role_id`
// for any rows that still lack an assignment — this keeps old seed
// data consistent after the migration lands without a separate script.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  permissions as permissionsTable,
  rolePermissions,
  roles as rolesTable,
  systemAccounts,
  users,
} from "../db/schema/index.ts";
import { loadPermissionCatalog } from "./catalog.ts";

export const BUILTIN_ROLE_NAMES = {
  ADMIN: "admin",
  MEMBER: "member",
  ENDUSER: "enduser",
  METRICS_SCRAPER: "metrics_scraper",
  PORTAL_TOKEN_USER: "portal_token_user",
} as const;

// Permission name filters for the non-admin built-in roles.
//
// Members manage their OWN operational resources (workflows,
// connectors, skills, schedules, subscriptions, inbound hooks,
// knowledge sources) — that includes the lifecycle right to DELETE
// them. Pre-fix the blanket `:delete` exclusion produced session
// 0aed284f's `permission_denied:connector:delete` /
// `permission_denied:workflow:delete` errors when a user tried to
// remove a connector + workflow they had just created. The fix is to
// drop the blanket and rely on the targeted prefix denies for the
// truly admin-only surfaces (rbac, audit, credential, api_key,
// discovery approval). credential:delete is already covered by the
// existing prefix filter above.
function memberPermissionFilter(name: string): boolean {
  if (name.startsWith("rbac:")) return false;
  if (name === "audit:read") return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name.startsWith("credential:") && name !== "credential:read") return false;
  if (name === "discovery:approve") return false;
  return true;
}

const ENDUSER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "execution:read",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
  "conversation:list",
  "knowledge:read",
]);
const METRICS_SCRAPER_PERMISSIONS = new Set<string>(["metrics:read"]);
const PORTAL_TOKEN_USER_PERMISSIONS = new Set<string>([
  "workflow:read",
  "workflow:run",
  "conversation:read",
  "conversation:write",
  "conversation:cancel",
]);

export interface SeededRoleIds {
  admin: string;
  member: string;
  enduser: string;
  metrics_scraper: string;
  portal_token_user: string;
}

async function upsertPermissions(db: Db): Promise<Map<string, string>> {
  const catalog = loadPermissionCatalog();
  for (const p of catalog) {
    await db
      .insert(permissionsTable)
      .values({ name: p.name, description: p.description, resource_type: p.resource_type })
      .onConflictDoNothing({ target: permissionsTable.name });
  }
  // tenant-filter:exempt — seed/migration utility
  const rows = await db
    .select({ id: permissionsTable.id, name: permissionsTable.name })
    .from(permissionsTable)
    .where(
      inArray(
        permissionsTable.name,
        catalog.map((p) => p.name),
      ),
    );
  const byName = new Map<string, string>();
  for (const r of rows) byName.set(r.name, r.id);
  return byName;
}

async function upsertBuiltinRole(db: Db, name: string, description: string): Promise<string> {
  const existing = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await db
    .insert(rolesTable)
    .values({ tenant_id: null, name, description, is_builtin: true })
    .returning({ id: rolesTable.id });
  if (!row) throw new Error(`rbac seed: failed to create role ${name}`);
  return row.id;
}

async function setRolePermissions(db: Db, roleId: string, permissionIds: string[]): Promise<void> {
  for (const pid of permissionIds) {
    await db
      .insert(rolePermissions)
      .values({ role_id: roleId, permission_id: pid })
      .onConflictDoNothing();
  }
}

/**
 * Seed the permission catalog + built-in roles. Idempotent. Returns
 * the ids of the built-in roles so callers can back-fill rows that
 * need a `role_id`.
 */
export async function seedBuiltinRolesAndPermissions(db: Db): Promise<SeededRoleIds> {
  const permIds = await upsertPermissions(db);
  const allPermIds = Array.from(permIds.values());

  const adminId = await upsertBuiltinRole(
    db,
    BUILTIN_ROLE_NAMES.ADMIN,
    "Full access to all resources",
  );
  const memberId = await upsertBuiltinRole(
    db,
    BUILTIN_ROLE_NAMES.MEMBER,
    "Day-to-day operator access: read + run + author + delete own operational resources (workflows, connectors, skills, schedules, subscriptions, inbound hooks, knowledge sources). NOT permitted: rbac changes, audit reads, secret/credential mutations, api_key lifecycle, discovery approvals.",
  );
  const enduserId = await upsertBuiltinRole(
    db,
    BUILTIN_ROLE_NAMES.ENDUSER,
    "Portal end-user: run approved workflows and view their executions",
  );
  const metricsScraperId = await upsertBuiltinRole(
    db,
    BUILTIN_ROLE_NAMES.METRICS_SCRAPER,
    "Prometheus scraper: scoped to metrics:read only",
  );
  const portalTokenUserId = await upsertBuiltinRole(
    db,
    BUILTIN_ROLE_NAMES.PORTAL_TOKEN_USER,
    "Backing role for portal-token principals; allowlist enforced by the evaluator",
  );

  const memberPermIds: string[] = [];
  for (const [name, pid] of permIds) {
    if (memberPermissionFilter(name)) memberPermIds.push(pid);
  }
  const enduserPermIds: string[] = [];
  const metricsScraperPermIds: string[] = [];
  const portalTokenUserPermIds: string[] = [];
  for (const [name, pid] of permIds) {
    if (ENDUSER_PERMISSIONS.has(name)) enduserPermIds.push(pid);
    if (METRICS_SCRAPER_PERMISSIONS.has(name)) metricsScraperPermIds.push(pid);
    if (PORTAL_TOKEN_USER_PERMISSIONS.has(name)) portalTokenUserPermIds.push(pid);
  }

  await setRolePermissions(db, adminId, allPermIds);
  await setRolePermissions(db, memberId, memberPermIds);
  await setRolePermissions(db, enduserId, enduserPermIds);
  await setRolePermissions(db, metricsScraperId, metricsScraperPermIds);
  await setRolePermissions(db, portalTokenUserId, portalTokenUserPermIds);

  return {
    admin: adminId,
    member: memberId,
    enduser: enduserId,
    metrics_scraper: metricsScraperId,
    portal_token_user: portalTokenUserId,
  };
}

/**
 * Back-fill `users.role_id` based on the legacy `users.role` enum
 * value and `system_accounts.role_id` based on the account name. Only
 * touches rows where `role_id IS NULL`.
 */
export async function backfillRoleIds(db: Db, ids: SeededRoleIds): Promise<void> {
  // Users: map enum role -> built-in role id.
  await db
    .update(users)
    .set({ role_id: ids.admin })
    .where(and(isNull(users.role_id), eq(users.role, "admin")));
  await db
    .update(users)
    .set({ role_id: ids.member })
    .where(and(isNull(users.role_id), eq(users.role, "member")));
  await db
    .update(users)
    .set({ role_id: ids.enduser })
    .where(and(isNull(users.role_id), eq(users.role, "enduser")));

  // System accounts: name-based heuristic. Everything unknown falls
  // back to `member` (NOT admin — that was the old default and it's
  // exactly the footgun C7 exists to close).
  await db
    .update(systemAccounts)
    .set({ role_id: ids.metrics_scraper })
    .where(
      and(isNull(systemAccounts.role_id), sql`${systemAccounts.name} LIKE 'metrics-scraper%'`),
    );
  await db
    .update(systemAccounts)
    .set({ role_id: ids.admin })
    .where(and(isNull(systemAccounts.role_id), sql`${systemAccounts.name} LIKE 'default-bot%'`));
  await db
    .update(systemAccounts)
    .set({ role_id: ids.admin })
    .where(and(isNull(systemAccounts.role_id), sql`${systemAccounts.name} LIKE 'bot-%'`));
  await db
    .update(systemAccounts)
    .set({ role_id: ids.member })
    .where(isNull(systemAccounts.role_id));
}
