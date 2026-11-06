import { and, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { roles, systemAccounts, users } from "../db/schema/index.ts";

export async function findUserRoleName(
  db: Executor,
  tenant_id: string,
  user_id: string,
): Promise<{ role_name: string | null } | undefined> {
  const [row] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.id, user_id), eq(users.tenant_id, tenant_id)))
    .limit(1);
  return row;
}

export async function findSystemAccountRoleId(
  db: Executor,
  tenant_id: string,
  system_account_id: string,
): Promise<{ role_id: string | null } | undefined> {
  const [row] = await db
    .select({ role_id: systemAccounts.role_id })
    .from(systemAccounts)
    .where(and(eq(systemAccounts.id, system_account_id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  return row;
}

export async function findRoleNameByRoleId(
  db: Executor,
  role_id: string,
): Promise<string | undefined> {
  // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
  const named = await db
    .select({ name: roles.name })
    .from(roles)
    .where(eq(roles.id, role_id))
    .limit(1);
  return named[0]?.name;
}

export async function listRoleNamesByRoleIds(
  db: Executor,
  role_ids: readonly string[],
): Promise<Array<{ id: string; name: string }>> {
  if (role_ids.length === 0) return [];
  // tenant-filter:exempt — RBAC catalog walk by role_id; handles both global rows (tenant_id IS NULL) and tenant rows
  return db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(inArray(roles.id, [...role_ids]));
}

export async function listRoleMembers(
  db: Executor,
  tenant_id: string,
  role_id: string,
): Promise<Array<{ id: string; email: string }>> {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.role_id, role_id)));
}
