// Resource grant service.
//
// Resource grants let an operator hand a specific (permission,
// resource) tuple to a user, system account, or group without
// promoting them to a higher role. The evaluator resolves grants
// before falling back to role-based checks.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { permissions as permissionsTable, resourceGrants } from "../db/schema/index.ts";

export type GrantSubjectType = "user" | "system_account" | "group";

export interface GrantInput {
  tenant_id: string;
  subject_type: GrantSubjectType;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permission: string;
  granted_by?: string | null;
  expires_at?: Date | null;
}

export interface GrantRow {
  id: string;
  tenant_id: string;
  subject_type: GrantSubjectType;
  subject_id: string;
  resource_type: string;
  resource_id: string;
  permission_id: string;
  permission_name: string;
  granted_by: string | null;
  created_at: Date;
  expires_at: Date | null;
}

async function resolvePermissionId(db: Db, name: string): Promise<string> {
  const rows = await db
    .select({ id: permissionsTable.id })
    .from(permissionsTable)
    .where(eq(permissionsTable.name, name))
    .limit(1);
  const id = rows[0]?.id;
  if (!id) throw new Error(`permission_unknown:${name}`);
  return id;
}

export async function grantResource(db: Db, input: GrantInput): Promise<GrantRow> {
  const permissionId = await resolvePermissionId(db, input.permission);
  const [row] = await db
    .insert(resourceGrants)
    .values({
      tenant_id: input.tenant_id,
      subject_type: input.subject_type,
      subject_id: input.subject_id,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      permission_id: permissionId,
      granted_by: input.granted_by ?? null,
      expires_at: input.expires_at ?? null,
    })
    .onConflictDoUpdate({
      target: [
        resourceGrants.tenant_id,
        resourceGrants.subject_type,
        resourceGrants.subject_id,
        resourceGrants.resource_type,
        resourceGrants.resource_id,
        resourceGrants.permission_id,
      ],
      set: { expires_at: input.expires_at ?? null },
    })
    .returning();
  if (!row) throw new Error("grant_insert_failed");
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_type: row.subject_type as GrantSubjectType,
    subject_id: row.subject_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    permission_id: row.permission_id,
    permission_name: input.permission,
    granted_by: row.granted_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function revokeResource(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(resourceGrants)
    .where(and(eq(resourceGrants.tenant_id, tenant_id), eq(resourceGrants.id, id)))
    .returning({ id: resourceGrants.id });
  return deleted.length > 0;
}

export async function listGrants(db: Db, tenant_id: string): Promise<GrantRow[]> {
  const rows = await db
    .select({
      id: resourceGrants.id,
      tenant_id: resourceGrants.tenant_id,
      subject_type: resourceGrants.subject_type,
      subject_id: resourceGrants.subject_id,
      resource_type: resourceGrants.resource_type,
      resource_id: resourceGrants.resource_id,
      permission_id: resourceGrants.permission_id,
      permission_name: permissionsTable.name,
      granted_by: resourceGrants.granted_by,
      created_at: resourceGrants.created_at,
      expires_at: resourceGrants.expires_at,
    })
    .from(resourceGrants)
    .innerJoin(permissionsTable, eq(permissionsTable.id, resourceGrants.permission_id))
    .where(eq(resourceGrants.tenant_id, tenant_id));
  return rows.map((r) => ({
    ...r,
    subject_type: r.subject_type as GrantSubjectType,
  }));
}

export async function listGrantsForSubject(
  db: Db,
  tenant_id: string,
  subject_type: GrantSubjectType,
  subject_id: string,
): Promise<GrantRow[]> {
  const rows = await db
    .select({
      id: resourceGrants.id,
      tenant_id: resourceGrants.tenant_id,
      subject_type: resourceGrants.subject_type,
      subject_id: resourceGrants.subject_id,
      resource_type: resourceGrants.resource_type,
      resource_id: resourceGrants.resource_id,
      permission_id: resourceGrants.permission_id,
      permission_name: permissionsTable.name,
      granted_by: resourceGrants.granted_by,
      created_at: resourceGrants.created_at,
      expires_at: resourceGrants.expires_at,
    })
    .from(resourceGrants)
    .innerJoin(permissionsTable, eq(permissionsTable.id, resourceGrants.permission_id))
    .where(
      and(
        eq(resourceGrants.tenant_id, tenant_id),
        eq(resourceGrants.subject_type, subject_type),
        eq(resourceGrants.subject_id, subject_id),
      ),
    );
  return rows.map((r) => ({
    ...r,
    subject_type: r.subject_type as GrantSubjectType,
  }));
}
