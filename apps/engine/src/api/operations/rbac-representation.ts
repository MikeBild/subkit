import { z } from "@hono/zod-openapi";
import type { GrantRow } from "../../rbac/grants.ts";
import type { GroupRow } from "../../rbac/groups.ts";
import {
  BuiltinImmutableError,
  PermissionNotFoundError,
  RoleInUseError,
  RoleNameReservedError,
  RoleNameTakenError,
  RoleNotFoundError,
  type RoleRow,
} from "../../rbac/roles.ts";
import { type Rejection, reject } from "./index.ts";

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

export const RbacRoleDetailSchema = RbacRoleSchema.extend({
  permissions: z.array(z.string()),
  member_count: z
    .number()
    .int()
    .nonnegative()
    .describe("Distinct people in this tenant assigned the role directly or through a group."),
}).openapi("RbacRoleDetail");

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

export const RbacGroupDetailSchema = RbacGroupSchema.extend({
  member_count: z.number().int().nonnegative(),
  member_ids: z
    .array(z.string().uuid())
    .describe("Existing people belonging to this tenant and group."),
}).openapi("RbacGroupDetail");

export const PermissionCatalogEntrySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    resource_type: z.string(),
    operator: z
      .boolean()
      .describe("True when only the engine operator workspace can exercise this permission"),
  })
  .openapi("PermissionCatalogEntry");

export const RbacCanResponseSchema = z
  .object({
    allow: z.boolean(),
    reason: z.string().nullable(),
    source: z.string().nullable(),
  })
  .openapi("RbacCanResponse");

export function serializeRole(r: RoleRow) {
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

export function serializeGrant(g: GrantRow) {
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

export function serializeGroup(g: GroupRow) {
  return {
    id: g.id,
    tenant_id: g.tenant_id,
    name: g.name,
    description: g.description,
    created_at: g.created_at.toISOString(),
    updated_at: g.updated_at.toISOString(),
  };
}

export function roleErrorRejection(err: unknown): Rejection {
  if (err instanceof BuiltinImmutableError) return reject.conflict("builtin_role_immutable");
  if (err instanceof RoleInUseError) return reject.conflict("role_in_use");
  if (err instanceof RoleNameReservedError) return reject.conflict("role_name_reserved");
  if (err instanceof RoleNameTakenError) return reject.conflict("role_name_taken");
  if (err instanceof RoleNotFoundError) return reject.notFound("role");
  if (err instanceof PermissionNotFoundError) return reject.badRequest(err.message);
  throw err as Error;
}
