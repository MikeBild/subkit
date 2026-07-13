// Shared serializers, Zod schemas + helpers for the RBAC HTTP surface.
// Every per-resource module imports from here. The schemas mirror the
// serializers exactly — same fields, same nullability.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import { users as usersTable } from "../../../db/schema/index.ts";
import type * as grantsSvc from "../../../rbac/index.ts";
import type * as groupsSvc from "../../../rbac/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors.ts";

export const RbacRoleSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    is_builtin: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RbacRole");

export const RbacRoleDetailSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    is_builtin: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    permissions: z.array(z.string()),
  })
  .openapi("RbacRoleDetail");

export const RbacGrantSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    subject_type: z.enum(["user", "system_account", "group"]),
    subject_id: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    permission_id: z.string(),
    permission: z.string(),
    granted_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi("RbacGrant");

export const RbacGroupSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RbacGroup");

export const PermissionCatalogEntrySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    resource_type: z.string(),
  })
  .openapi("PermissionCatalogEntry");

export const RbacCanResponseSchema = z
  .object({
    allow: z.boolean(),
    reason: z.string().nullable(),
    source: z.string().nullable(),
  })
  .openapi("RbacCanResponse");

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
