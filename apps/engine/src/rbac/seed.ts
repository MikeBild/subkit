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
  // identity:write mutates users, tenants, and provisioning invites across the
  // tenant — creating users, changing roles, deactivating accounts, minting
  // and revoking invites. That is administrative authority, not day-to-day
  // operator work, so members must NOT hold it. Handler-level `adminOnly`
  // checks stay as defense-in-depth; this keeps the permission name honest.
  // identity:read is read-only and stays: members rely on it for surfaces
  // like /v1/diagnostics/setup (gated audit:read OR identity:read).
  if (name === "identity:write") return false;
  // stats:read exposes cross-workflow operational posture (failure
  // rates, connector rate-limit floods, LLM spend) that a typical
  // member working on their own connector/workflow does not need.
  // Tenants who want every member to see stats add it to a custom role.
  if (name === "stats:read") return false;
  // stats:read:all exposes OTHER users' LLM spend + cross-user breakdowns —
  // strictly admin. Members must never see a colleague's usage (the
  // load-bearing privacy control); their own usage is the /v1/status surface.
  if (name === "stats:read:all") return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name.startsWith("credential:") && name !== "credential:read") return false;
  if (name === "discovery:approve") return false;
  // mcp:admin grants full administrative access over MCP — admin-only,
  // same posture as the rbac:/audit:read/api_key: denials above.
  if (name === "mcp:admin") return false;
  // mcp_server:manage registers / configures / removes external MCP
  // servers (their auth_config references encrypted credential rows) —
  // admin-only, same posture as mcp:admin. mcp_external_tool:invoke is
  // intentionally NOT denied here: members may invoke tools exposed by
  // a server an admin already registered.
  if (name === "mcp_server:manage") return false;
  // mcp_oauth_client:* is admin-only — these are platform-global rows
  // (no tenant_id) and must not be exposed to member-level principals.
  if (name.startsWith("mcp_oauth_client:")) return false;
  // chat_workspace:write installs or removes a tenant-wide
  // Slack/Teams/Google app binding (with encrypted bot credentials);
  // the DELETE route gates on `:write` per the project convention,
  // so a separate `:delete` permission isn't defined.
  // chat_identity:write binds external chat users to subkit principals
  // across the tenant (same DELETE→`:write` convention). Both are
  // admin-only operations; members keep `:read` so ops dashboards
  // still work.
  if (name.startsWith("chat_workspace:") && name !== "chat_workspace:read") return false;
  if (name.startsWith("chat_identity:") && name !== "chat_identity:read") return false;
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
  "file:read",
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
