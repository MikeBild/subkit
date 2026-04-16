// Group service — create, update, delete, member add/remove, and
// role assign/revoke.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { groupMembers, groupRoleAssignments, groups } from "../db/schema/index.ts";

export interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createGroup(
  db: Db,
  tenant_id: string,
  name: string,
  description?: string,
): Promise<GroupRow> {
  const [row] = await db
    .insert(groups)
    .values({ tenant_id, name, description: description ?? null })
    .returning();
  if (!row) throw new Error("group_insert_failed");
  return row;
}

export async function updateGroup(
  db: Db,
  tenant_id: string,
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<GroupRow | null> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  const [row] = await db
    .update(groups)
    .set(set)
    .where(and(eq(groups.tenant_id, tenant_id), eq(groups.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteGroup(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(groups)
    .where(and(eq(groups.tenant_id, tenant_id), eq(groups.id, id)))
    .returning({ id: groups.id });
  return deleted.length > 0;
}

export async function listGroups(db: Db, tenant_id: string): Promise<GroupRow[]> {
  return db.select().from(groups).where(eq(groups.tenant_id, tenant_id));
}

export async function getGroup(db: Db, tenant_id: string, id: string): Promise<GroupRow | null> {
  const rows = await db
    .select()
    .from(groups)
    .where(and(eq(groups.tenant_id, tenant_id), eq(groups.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function addMember(
  db: Db,
  group_id: string,
  user_id: string,
  added_by?: string | null,
): Promise<void> {
  await db
    .insert(groupMembers)
    .values({ group_id, user_id, added_by: added_by ?? null })
    .onConflictDoNothing();
}

export async function removeMember(db: Db, group_id: string, user_id: string): Promise<boolean> {
  const deleted = await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.group_id, group_id), eq(groupMembers.user_id, user_id)))
    .returning({ group_id: groupMembers.group_id });
  return deleted.length > 0;
}

export async function listMembers(db: Db, group_id: string): Promise<string[]> {
  const rows = await db
    .select({ user_id: groupMembers.user_id })
    .from(groupMembers)
    .where(eq(groupMembers.group_id, group_id));
  return rows.map((r) => r.user_id);
}

export async function assignRoleToGroup(db: Db, group_id: string, role_id: string): Promise<void> {
  await db.insert(groupRoleAssignments).values({ group_id, role_id }).onConflictDoNothing();
}

export async function revokeRoleFromGroup(
  db: Db,
  group_id: string,
  role_id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(groupRoleAssignments)
    .where(
      and(eq(groupRoleAssignments.group_id, group_id), eq(groupRoleAssignments.role_id, role_id)),
    )
    .returning({ group_id: groupRoleAssignments.group_id });
  return deleted.length > 0;
}

export async function listGroupRoles(db: Db, group_id: string): Promise<string[]> {
  const rows = await db
    .select({ role_id: groupRoleAssignments.role_id })
    .from(groupRoleAssignments)
    .where(eq(groupRoleAssignments.group_id, group_id));
  return rows.map((r) => r.role_id);
}
