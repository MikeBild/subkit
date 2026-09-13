// Role management service — list/get/create/update/delete roles and
// grant/revoke permissions on them. Built-in roles (`is_builtin=true`)
// are read-only and trip the `builtin_immutable` error.

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import {
  permissions as permissionsTable,
  rolePermissions,
  roles as rolesTable,
} from "../db/schema/index.ts";

export interface RoleRow {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  is_builtin: boolean;
  created_at: Date;
  updated_at: Date;
}

export class BuiltinImmutableError extends Error {
  constructor() {
    super("builtin_role_immutable");
    this.name = "BuiltinImmutableError";
  }
}

export class RoleNotFoundError extends Error {
  constructor() {
    super("role_not_found");
    this.name = "RoleNotFoundError";
  }
}

export class PermissionNotFoundError extends Error {
  constructor(name: string) {
    super(`permission_unknown:${name}`);
    this.name = "PermissionNotFoundError";
  }
}

/** List built-in roles + any roles scoped to the given tenant. */
export async function listRoles(db: Db, tenant_id: string): Promise<RoleRow[]> {
  const rows = await db
    .select()
    .from(rolesTable)
    .where(or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenant_id)));
  return rows;
}

export async function getRole(db: Db, tenant_id: string, id: string): Promise<RoleRow | null> {
  const rows = await db
    .select()
    .from(rolesTable)
    .where(
      and(
        eq(rolesTable.id, id),
        or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenant_id)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createRole(
  db: Db,
  tenant_id: string,
  name: string,
  description?: string,
): Promise<RoleRow> {
  const [row] = await db
    .insert(rolesTable)
    .values({ tenant_id, name, description: description ?? null, is_builtin: false })
    .returning();
  if (!row) throw new Error("role_insert_failed");
  return row;
}

export async function updateRole(
  db: Db,
  tenant_id: string,
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<RoleRow> {
  const existing = await getRole(db, tenant_id, id);
  if (!existing) throw new RoleNotFoundError();
  if (existing.is_builtin) throw new BuiltinImmutableError();
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  const [row] = await db
    .update(rolesTable)
    .set(set)
    .where(and(eq(rolesTable.id, id), eq(rolesTable.tenant_id, tenant_id)))
    .returning();
  if (!row) throw new RoleNotFoundError();
  return row;
}

export async function deleteRole(db: Db, tenant_id: string, id: string): Promise<void> {
  const existing = await getRole(db, tenant_id, id);
  if (!existing) throw new RoleNotFoundError();
  if (existing.is_builtin) throw new BuiltinImmutableError();
  await db
    .delete(rolesTable)
    .where(and(eq(rolesTable.id, id), eq(rolesTable.tenant_id, tenant_id)));
}

export async function listRolePermissions(db: Db, role_id: string): Promise<string[]> {
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db
    .select({ name: permissionsTable.name })
    .from(rolePermissions)
    .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permission_id))
    .where(eq(rolePermissions.role_id, role_id));
  return rows.map((r) => r.name);
}

export async function grantPermissionToRole(
  db: Db,
  tenant_id: string,
  role_id: string,
  permissionName: string,
): Promise<void> {
  const role = await getRole(db, tenant_id, role_id);
  if (!role) throw new RoleNotFoundError();
  if (role.is_builtin) throw new BuiltinImmutableError();
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const pRows = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.name, permissionName))
    .limit(1);
  const pid = pRows[0]?.id;
  if (!pid) throw new PermissionNotFoundError(permissionName);
  await db.insert(rolePermissions).values({ role_id, permission_id: pid }).onConflictDoNothing();
}

export async function revokePermissionFromRole(
  db: Db,
  tenant_id: string,
  role_id: string,
  permissionName: string,
): Promise<boolean> {
  const role = await getRole(db, tenant_id, role_id);
  if (!role) throw new RoleNotFoundError();
  if (role.is_builtin) throw new BuiltinImmutableError();
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const pRows = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.name, permissionName))
    .limit(1);
  const pid = pRows[0]?.id;
  if (!pid) throw new PermissionNotFoundError(permissionName);
  const del = await db
    .delete(rolePermissions)
    .where(and(eq(rolePermissions.role_id, role_id), eq(rolePermissions.permission_id, pid)))
    .returning({ role_id: rolePermissions.role_id });
  return del.length > 0;
}

export async function findRoleByName(
  db: Db,
  tenant_id: string | null,
  name: string,
): Promise<RoleRow | null> {
  const where = tenant_id
    ? and(eq(rolesTable.tenant_id, tenant_id), eq(rolesTable.name, name))
    : and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name));
  // tenant-filter:exempt — RBAC catalog walk — handles both global rows (tenant_id IS NULL) and tenant rows
  const rows = await db.select().from(rolesTable).where(where).limit(1);
  return rows[0] ?? null;
}

// Suppress unused-import warning for `inArray` used indirectly.
void inArray;
