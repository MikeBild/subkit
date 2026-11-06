import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db, Executor } from "../db/client.ts";
import {
  groupMembers,
  groupRoleAssignments,
  groups,
  permissions as permissionsTable,
  rolePermissions,
  roles as rolesTable,
  users,
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

export class RoleInUseError extends Error {
  constructor() {
    super("role_in_use");
    this.name = "RoleInUseError";
  }
}

export class PermissionNotFoundError extends Error {
  constructor(name: string) {
    super(`permission_unknown:${name}`);
    this.name = "PermissionNotFoundError";
  }
}

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
  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.role_id, id)))
    .limit(1);
  if (holder) throw new RoleInUseError();
  await db
    .delete(rolesTable)
    .where(and(eq(rolesTable.id, id), eq(rolesTable.tenant_id, tenant_id)));
}

export async function listRolePermissions(
  db: Db,
  tenant_id: string,
  role_id: string,
): Promise<string[]> {
  const rows = await db
    .select({ name: permissionsTable.name })
    .from(rolePermissions)
    .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permission_id))
    .innerJoin(rolesTable, eq(rolesTable.id, rolePermissions.role_id))
    .where(
      and(
        eq(rolePermissions.role_id, role_id),
        or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenant_id)),
      ),
    );
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

export async function builtinRoleId(exec: Executor, name: string): Promise<string> {
  // tenant-filter:exempt — built-in roles are global RBAC catalog rows.
  const [row] = await exec
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(isNull(rolesTable.tenant_id), eq(rolesTable.name, name)))
    .limit(1);
  if (!row) throw new RoleNotFoundError();
  return row.id;
}

void inArray;

export async function roleMemberCounts(db: Db, tenant_id: string) {
  const rows = await db
    .select({
      id: rolesTable.id,
      member_count: sql<number>`(
      select count(*)::int from ${users}
      where "users"."tenant_id" = ${tenant_id}
      and (
        "users"."role_id" = "roles"."id"
        or exists (
          select 1 from ${groupMembers}
          inner join ${groups} on "groups"."id" = "group_members"."group_id"
          inner join ${groupRoleAssignments} on "group_role_assignments"."group_id" = "groups"."id"
          where "groups"."tenant_id" = ${tenant_id}
          and "group_members"."user_id" = "users"."id"
          and "group_role_assignments"."role_id" = "roles"."id"
        )
      )
    )`,
    })
    .from(rolesTable)
    .where(or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenant_id)));
  return new Map(rows.map((row) => [row.id, row.member_count]));
}

export async function tenantRolePermissions(db: Db, tenant_id: string) {
  const rows = await db
    .select({ role_id: rolesTable.id, permission: permissionsTable.name })
    .from(rolesTable)
    .innerJoin(rolePermissions, eq(rolePermissions.role_id, rolesTable.id))
    .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permission_id))
    .where(or(isNull(rolesTable.tenant_id), eq(rolesTable.tenant_id, tenant_id)))
    .orderBy(permissionsTable.name);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const permissions = result.get(row.role_id) ?? [];
    permissions.push(row.permission);
    result.set(row.role_id, permissions);
  }
  return result;
}
