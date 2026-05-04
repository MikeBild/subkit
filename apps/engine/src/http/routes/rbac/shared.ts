// Shared serializers + helpers for the RBAC HTTP surface. After the
// Phase 4 split (audit §4.4) every per-resource module imports from
// here.

import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { users as usersTable } from "../../../db/schema/index.ts";
import type * as grantsSvc from "../../../rbac/grants.ts";
import type * as groupsSvc from "../../../rbac/groups.ts";
import * as rolesSvc from "../../../rbac/roles.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors.ts";

export function serializeRole(r: rolesSvc.RoleRow) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    is_builtin: r.is_builtin,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

export function serializeGrant(g: grantsSvc.GrantRow) {
  return {
    id: g.id,
    tenant_id: g.tenant_id,
    subject_type: g.subject_type,
    subject_id: g.subject_id,
    resource_type: g.resource_type,
    resource_id: g.resource_id,
    permission_id: g.permission_id,
    permission: g.permission_name,
    granted_by: g.granted_by,
    created_at: g.created_at.toISOString(),
    expires_at: g.expires_at ? g.expires_at.toISOString() : null,
  };
}

export function serializeGroup(g: groupsSvc.GroupRow) {
  return {
    id: g.id,
    tenant_id: g.tenant_id,
    name: g.name,
    description: g.description,
    created_at: g.created_at.toISOString(),
    updated_at: g.updated_at.toISOString(),
  };
}

export function mapRoleError(err: unknown): never {
  if (err instanceof rolesSvc.BuiltinImmutableError) {
    throw new ConflictError("builtin_role_immutable");
  }
  if (err instanceof rolesSvc.RoleNotFoundError) {
    throw new NotFoundError("role");
  }
  if (err instanceof rolesSvc.PermissionNotFoundError) {
    throw new BadRequestError(err.message);
  }
  throw err as Error;
}

export async function buildQueryPrincipal(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<{
  provider: string;
  kind: "user" | "system_account";
  id: string;
  tenant_id: string;
  roles: string[];
} | null> {
  const { roles: rolesTable, systemAccounts } = await import("../../../db/schema/index.ts");
  // Try user first.
  const uRows = await db
    .select({ id: usersTable.id, role: usersTable.role, role_name: rolesTable.name })
    .from(usersTable)
    .leftJoin(rolesTable, eq(rolesTable.id, usersTable.role_id))
    .where(and(eq(usersTable.id, id), eq(usersTable.tenant_id, tenant_id)))
    .limit(1);
  if (uRows[0]) {
    return {
      provider: "rbac_query",
      kind: "user",
      id,
      tenant_id,
      roles: [uRows[0].role_name ?? uRows[0].role],
    };
  }
  // Fall back to system account.
  const sRows = await db
    .select({
      id: systemAccounts.id,
      role_name: rolesTable.name,
    })
    .from(systemAccounts)
    .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
    .where(and(eq(systemAccounts.id, id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  if (sRows[0]) {
    return {
      provider: "rbac_query",
      kind: "system_account",
      id,
      tenant_id,
      roles: [sRows[0].role_name ?? "member"],
    };
  }
  return null;
}
