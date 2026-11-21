import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  permissions as permissionsTable,
  rolePermissions,
  roles as rolesTable,
  systemAccounts,
} from "../db/schema/index.ts";
import { isOperatorPermission, loadPermissionCatalog } from "./catalog.ts";

export const BUILTIN_ROLE_NAMES = {
  ADMIN: "admin",
  MEMBER: "member",
  ENDUSER: "enduser",
  METRICS_SCRAPER: "metrics_scraper",
  PORTAL_TOKEN_USER: "portal_token_user",
} as const;

function memberPermissionFilter(name: string): boolean {
  if (isOperatorPermission(name)) return false;
  if (name.startsWith("rbac:")) return false;
  if (name === "audit:read") return false;
  if (name === "identity:write") return false;
  if (name === "stats:read") return false;
  if (name === "stats:read:all") return false;
  if (name.startsWith("self_healing:")) return false;
  if (name === "api_key:write") return false;
  if (name === "api_key:rotate") return false;
  if (name === "api_key:revoke") return false;
  if (name === "connector:promote") return false;
  if (name.startsWith("vault:") && name !== "vault:read") return false;
  if (name === "discovery:approve") return false;
  if (name === "mcp:admin") return false;
  if (name.startsWith("mcp_oauth_client:")) return false;
  if (name === "system:restart") return false;
  if (name === "device:revoke_any") return false;
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
  "skill:read",
  "file:read",
  "local:confirm",
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
    .select({ id: rolesTable.id, description: rolesTable.description })
    .from(rolesTable)
    .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
    .limit(1);
  if (existing[0]) {
    if (existing[0].description !== description) {
      await db.update(rolesTable).set({ description }).where(eq(rolesTable.id, existing[0].id));
    }
    return existing[0].id;
  }
  const [row] = await db
    .insert(rolesTable)
    .values({ tenant_id: null, name, description, is_builtin: true })
    .returning({ id: rolesTable.id });
  if (!row) throw new Error(`rbac seed: failed to create role ${name}`);
  return row.id;
}

async function removeRolePermissions(
  db: Db,
  roleId: string,
  permissionIds: string[],
): Promise<void> {
  if (permissionIds.length === 0) return;
  await db
    .delete(rolePermissions)
    .where(
      and(
        eq(rolePermissions.role_id, roleId),
        inArray(rolePermissions.permission_id, permissionIds),
      ),
    );
}

async function setRolePermissions(db: Db, roleId: string, permissionIds: string[]): Promise<void> {
  for (const pid of permissionIds) {
    await db
      .insert(rolePermissions)
      .values({ role_id: roleId, permission_id: pid })
      .onConflictDoNothing();
  }
}

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
    "Day-to-day operator access: read + run + author + delete own operational resources (workflows, connectors, skills, schedules, subscriptions, inbound hooks, knowledge sources) and export or import packages. NOT permitted: rbac changes, audit reads, secret/credential mutations, api_key lifecycle, discovery approvals.",
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
  const memberExcludedOperatorIds: string[] = [];
  for (const [name, pid] of permIds) {
    if (memberPermissionFilter(name)) memberPermIds.push(pid);
    else if (isOperatorPermission(name)) memberExcludedOperatorIds.push(pid);
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
  await removeRolePermissions(db, memberId, memberExcludedOperatorIds);
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

export async function backfillSystemAccountRoleIds(db: Db, ids: SeededRoleIds): Promise<void> {
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
