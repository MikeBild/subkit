import { z } from "@hono/zod-openapi";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, type AuditActionValue } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { LastAdminError } from "../../identity/last-admin.ts";
import { assignUserRole } from "../../identity/user-role.ts";
import { loadPermissionCatalog } from "../../rbac/catalog.ts";
import { can } from "../../rbac/evaluator.ts";
import { type GrantRow, grantResource, listGrants, revokeResource } from "../../rbac/grants.ts";
import {
  addMember,
  assignRoleToGroup,
  createGroup,
  deleteGroup,
  type GroupRow,
  getGroup,
  listGroups,
  listTenantGroupMemberships,
  removeMember,
  revokeRoleFromGroup,
  updateGroup,
} from "../../rbac/groups.ts";
import { buildQueryPrincipal } from "../../rbac/query-principal.ts";
import {
  createRole,
  deleteRole,
  getRole,
  grantPermissionToRole,
  listRolePermissions,
  listRoles,
  type RoleRow,
  revokePermissionFromRole,
  roleMemberCounts,
  tenantRolePermissions,
  updateRole,
} from "../../rbac/roles.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";
import {
  PermissionCatalogEntrySchema,
  RbacCanResponseSchema,
  RbacGrantSchema,
  RbacGroupDetailSchema,
  RbacGroupSchema,
  RbacRoleDetailSchema,
  RbacRoleSchema,
  roleErrorRejection,
  serializeGrant,
  serializeGroup,
  serializeRole,
} from "./rbac-representation.ts";

const TAGS = ["rbac"] as const;
const OkResponse = z.object({ ok: z.literal(true) });
const RolePermissionParams = z.object({ id: z.string().uuid(), permission: z.string() });
const GroupMemberParams = z.object({ id: z.string().uuid(), user_id: z.string().uuid() });
const GroupRoleParams = z.object({ id: z.string().uuid(), role_id: z.string().uuid() });
const UserIdParam = z.object({ user_id: z.string().uuid() });

const CreateRoleBody = z
  .object({ name: z.string(), description: z.string().optional() })
  .openapi("CreateRbacRoleRequest");
const UpdateRoleBody = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("UpdateRbacRoleRequest");
const GrantRolePermissionBody = z
  .object({ permission: z.string() })
  .openapi("GrantRolePermissionRequest");
const AssignUserRoleBody = z.object({ role_id: z.string() }).openapi("AssignUserRoleRequest");
const AssignUserRoleResponse = z
  .object({
    ok: z.literal(true),
    user_id: z.string(),
    role_id: z.string(),
  })
  .openapi("AssignUserRoleResponse");
const CreateGrantBody = z
  .object({
    subject_type: z.enum(["user", "system_account", "group"]),
    subject_id: z.string(),
    resource_type: z.string(),
    resource_id: z.string(),
    permission: z.string(),
    expires_at: z.string().nullable().optional(),
  })
  .openapi("CreateRbacGrantRequest");
const CreateGroupBody = z
  .object({ name: z.string(), description: z.string().optional() })
  .openapi("CreateRbacGroupRequest");
const UpdateGroupBody = z
  .object({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("UpdateRbacGroupRequest");
const CanBody = z
  .object({
    principal_id: z.string(),
    permission: z.string(),
    resource: z.object({ type: z.string(), id: z.string() }).optional(),
  })
  .openapi("RbacCanRequest");

type CreateNamed = z.infer<typeof CreateRoleBody>;
type UpdateNamed = z.infer<typeof UpdateRoleBody>;
type CreateGrantInput = z.infer<typeof CreateGrantBody>;
type CanInput = z.infer<typeof CanBody>;

interface UpdateInput {
  readonly id: string;
  readonly body: UpdateNamed;
}

interface AssignUserRoleInput {
  readonly user_id: string;
  readonly role_id: string;
}

interface AssignedUserRole {
  readonly ok: true;
  readonly user_id: string;
  readonly role_id: string;
}

interface CanDecision {
  readonly allow: boolean;
  readonly reason: string | null;
  readonly source: string | null;
}

interface IdInput {
  readonly id: string;
}

interface RolePermissionInput {
  readonly id: string;
  readonly permission: string;
}

interface GroupMemberInput {
  readonly id: string;
  readonly user_id: string;
}

interface GroupRoleInput {
  readonly id: string;
  readonly role_id: string;
}

interface Ok {
  readonly ok: true;
}

const OK: Ok = { ok: true };

async function audited(
  scope: OperationScope,
  principal: ResolvedPrincipal,
  action: AuditActionValue,
  resource_type: string,
  resource_id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await auditAwait(
    {
      tenant_id: principal.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
      action,
      resource_type,
      resource_id,
      result: "success",
      metadata,
    },
    scope.db,
  );
}

async function roleChange(change: () => Promise<unknown>): Promise<Rejection | null> {
  try {
    await change();
    return null;
  } catch (err) {
    return roleErrorRejection(err);
  }
}

export const listPermissionsOperation = defineOperation<
  null,
  ReturnType<typeof loadPermissionCatalog>
>({
  id: "rbac.permission.list",
  summary: "List the permission catalog",
  permission: "rbac:read",
  effect: "read",
  async handler() {
    return loadPermissionCatalog();
  },
  http: {
    method: "get",
    path: "/v1/rbac/permissions",
    tags: TAGS,
    response: z
      .object({ items: z.array(PermissionCatalogEntrySchema) })
      .openapi("RbacPermissionListResponse"),
    toInput: () => null,
    toBody: (catalog) => ({
      items: catalog.map((p) => ({
        name: p.name,
        description: p.description,
        resource_type: p.resource_type,
        operator: p.operator === true,
      })),
    }),
  },
});

interface RoleListResult {
  readonly roles: Awaited<ReturnType<typeof listRoles>>;
  readonly counts: Awaited<ReturnType<typeof roleMemberCounts>>;
  readonly permissions: Awaited<ReturnType<typeof tenantRolePermissions>>;
}

export const listRolesOperation = defineOperation<null, RoleListResult>({
  id: "rbac.role.list",
  summary: "List roles",
  permission: "rbac:read",
  effect: "read",
  async handler(scope) {
    const roles = await listRoles(scope.db, scope.tenant_id);
    const [counts, permissions] = await Promise.all([
      roleMemberCounts(scope.db, scope.tenant_id),
      tenantRolePermissions(scope.db, scope.tenant_id),
    ]);
    return { roles, counts, permissions };
  },
  http: {
    method: "get",
    path: "/v1/rbac/roles",
    tags: TAGS,
    response: z.object({ items: z.array(RbacRoleDetailSchema) }).openapi("RbacRoleListResponse"),
    toInput: () => null,
    toBody: ({ roles, counts, permissions }) => ({
      items: roles.map((role) => ({
        ...serializeRole(role),
        member_count: counts.get(role.id) ?? 0,
        permissions: permissions.get(role.id) ?? [],
      })),
    }),
  },
});

interface RoleDetail {
  readonly role: NonNullable<Awaited<ReturnType<typeof getRole>>>;
  readonly permissions: string[];
  readonly member_count: number;
}

export const getRoleOperation = defineOperation<IdInput, RoleDetail>({
  id: "rbac.role.get",
  summary: "Get a role with its permissions",
  permission: "rbac:read",
  effect: "read",
  async handler(scope, { id }) {
    const role = await getRole(scope.db, scope.tenant_id, id);
    if (!role) return reject.notFound("role");
    const permissions = await listRolePermissions(scope.db, scope.tenant_id, role.id);
    const counts = await roleMemberCounts(scope.db, scope.tenant_id);
    return { role, permissions, member_count: counts.get(role.id) ?? 0 };
  },
  http: {
    method: "get",
    path: "/v1/rbac/roles/{id}",
    tags: TAGS,
    params: IdParam,
    response: RbacRoleDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as IdInput).id }),
    toBody: ({ role, permissions, member_count }) => ({
      ...serializeRole(role),
      permissions,
      member_count,
    }),
  },
});

function namedPatch(body: UpdateNamed) {
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
  };
}

export const createRoleOperation = defineOperation<CreateNamed, RoleRow>({
  id: "rbac.role.create",
  summary: "Create a custom role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_ROLE_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    let role: RoleRow;
    try {
      role = await createRole(scope.db, scope.tenant_id, body.name, body.description);
    } catch (err) {
      return roleErrorRejection(err);
    }
    await audited(scope, principal, AuditAction.RBAC_ROLE_CREATED, "role", role.id, {
      name: role.name,
    });
    return role;
  },
  http: {
    method: "post",
    path: "/v1/rbac/roles",
    tags: TAGS,
    body: CreateRoleBody,
    bodyRequired: true,
    response: RbacRoleSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request", 409: "Role name is reserved or already taken" },
    toInput: ({ json }) => json as CreateNamed,
    toBody: serializeRole,
  },
});

export const updateRoleOperation = defineOperation<UpdateInput, RoleRow>({
  id: "rbac.role.update",
  summary: "Update a custom role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_ROLE_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    let role: RoleRow;
    try {
      role = await updateRole(scope.db, scope.tenant_id, id, namedPatch(body));
    } catch (err) {
      return roleErrorRejection(err);
    }
    await audited(scope, principal, AuditAction.RBAC_ROLE_UPDATED, "role", role.id, {
      patch: body,
    });
    return role;
  },
  http: {
    method: "patch",
    path: "/v1/rbac/roles/{id}",
    tags: TAGS,
    params: IdParam,
    body: UpdateRoleBody,
    bodyRequired: true,
    response: RbacRoleSchema,
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param, json }) => ({ id: (param as IdInput).id, body: json as UpdateNamed }),
    toBody: serializeRole,
  },
});

export const deleteRoleOperation = defineOperation<IdInput, Ok>({
  id: "rbac.role.delete",
  summary: "Delete a custom role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_ROLE_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const failed = await roleChange(() => deleteRole(scope.db, scope.tenant_id, id));
    if (failed) return failed;
    await audited(scope, principal, AuditAction.RBAC_ROLE_DELETED, "role", id, {});
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/roles/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param }) => ({ id: (param as IdInput).id }),
    toBody: () => null,
  },
});

export const grantRolePermissionOperation = defineOperation<RolePermissionInput, Ok>({
  id: "rbac.role.permission.grant",
  summary: "Grant a permission to a role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_ROLE_PERMISSION_GRANTED,
  async handler(scope, { id, permission }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const failed = await roleChange(() =>
      grantPermissionToRole(scope.db, scope.tenant_id, id, permission),
    );
    if (failed) return failed;
    await audited(scope, principal, AuditAction.RBAC_ROLE_PERMISSION_GRANTED, "role", id, {
      permission,
    });
    return OK;
  },
  http: {
    method: "post",
    path: "/v1/rbac/roles/{id}/permissions",
    tags: TAGS,
    params: IdParam,
    body: GrantRolePermissionBody,
    bodyRequired: true,
    response: OkResponse,
    errors: { 400: "Bad request", 404: "Not found", 409: "Conflict" },
    toInput: ({ param, json }) => ({
      id: (param as IdInput).id,
      permission: (json as { permission: string }).permission,
    }),
    toBody: (ok) => ok,
  },
});

export const revokeRolePermissionOperation = defineOperation<RolePermissionInput, Ok>({
  id: "rbac.role.permission.revoke",
  summary: "Revoke a permission from a role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_ROLE_PERMISSION_REVOKED,
  async handler(scope, { id, permission }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const failed = await roleChange(() =>
      revokePermissionFromRole(scope.db, scope.tenant_id, id, permission),
    );
    if (failed) return failed;
    await audited(scope, principal, AuditAction.RBAC_ROLE_PERMISSION_REVOKED, "role", id, {
      permission,
    });
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/roles/{id}/permissions/{permission}",
    tags: TAGS,
    params: RolePermissionParams,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param }) => {
      const { id, permission } = param as RolePermissionInput;
      return { id, permission };
    },
    toBody: () => null,
  },
});

export const assignUserRoleOperation = defineOperation<AssignUserRoleInput, AssignedUserRole>({
  id: "rbac.user.role.assign",
  summary: "Assign a user's role",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_USER_ROLE_ASSIGNED,
  async handler(scope, { user_id, role_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const role = await getRole(scope.db, scope.tenant_id, role_id);
    if (!role) return reject.badRequest("role_id not found");
    let assigned: boolean;
    try {
      assigned = await assignUserRole(scope.db, {
        tenant_id: scope.tenant_id,
        user_id,
        role_id,
        role_name: role.name,
        actor: principal,
      });
    } catch (err) {
      if (err instanceof LastAdminError) return reject.status(409, "last_admin", err.message);
      throw err;
    }
    if (!assigned) return reject.notFound("user");
    return { ok: true, user_id, role_id };
  },
  http: {
    method: "post",
    path: "/v1/rbac/users/{user_id}/role",
    tags: TAGS,
    params: UserIdParam,
    body: AssignUserRoleBody,
    bodyRequired: true,
    response: AssignUserRoleResponse,
    errors: {
      400: "Bad request",
      404: "Not found",
      409: "last_admin — the change would leave the workspace without an administrator",
    },
    toInput: ({ param, json }) => ({
      user_id: (param as { user_id: string }).user_id,
      role_id: (json as { role_id: string }).role_id,
    }),
    toBody: (assigned) => assigned,
  },
});

export const listGrantsOperation = defineOperation<null, Awaited<ReturnType<typeof listGrants>>>({
  id: "rbac.grant.list",
  summary: "List resource grants",
  permission: "rbac:read",
  effect: "read",
  async handler(scope) {
    return listGrants(scope.db, scope.tenant_id);
  },
  http: {
    method: "get",
    path: "/v1/rbac/grants",
    tags: TAGS,
    response: z.object({ items: z.array(RbacGrantSchema) }).openapi("RbacGrantListResponse"),
    toInput: () => null,
    toBody: (grants) => ({ items: grants.map(serializeGrant) }),
  },
});

export const createGrantOperation = defineOperation<CreateGrantInput, GrantRow>({
  id: "rbac.grant.create",
  summary: "Create a resource grant",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GRANT_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    let grant: GrantRow;
    try {
      grant = await grantResource(scope.db, {
        tenant_id: scope.tenant_id,
        subject_type: body.subject_type,
        subject_id: body.subject_id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        permission: body.permission,
        granted_by: principal.id,
        expires_at: body.expires_at ? new Date(body.expires_at) : null,
      });
    } catch (err) {
      if ((err as Error).message?.startsWith("permission_unknown:")) {
        return reject.badRequest((err as Error).message);
      }
      throw err as Error;
    }
    await audited(scope, principal, AuditAction.RBAC_GRANT_CREATED, "resource_grant", grant.id, {
      subject_type: grant.subject_type,
      subject_id: grant.subject_id,
      permission: grant.permission_name,
      resource_type: grant.resource_type,
      resource_id: grant.resource_id,
    });
    return grant;
  },
  http: {
    method: "post",
    path: "/v1/rbac/grants",
    tags: TAGS,
    body: CreateGrantBody,
    bodyRequired: true,
    response: RbacGrantSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request" },
    toInput: ({ json }) => json as CreateGrantInput,
    toBody: serializeGrant,
  },
});

export const deleteGrantOperation = defineOperation<IdInput, Ok>({
  id: "rbac.grant.delete",
  summary: "Revoke a resource grant",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GRANT_REVOKED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await revokeResource(scope.db, scope.tenant_id, id);
    if (!ok) return reject.notFound("grant");
    await audited(scope, principal, AuditAction.RBAC_GRANT_REVOKED, "resource_grant", id, {});
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/grants/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as IdInput).id }),
    toBody: () => null,
  },
});

interface GroupListResult {
  readonly groups: Awaited<ReturnType<typeof listGroups>>;
  readonly members: ReadonlyMap<string, string[]>;
}

export const listGroupsOperation = defineOperation<null, GroupListResult>({
  id: "rbac.group.list",
  summary: "List groups",
  permission: "rbac:read",
  effect: "read",
  async handler(scope) {
    const groups = await listGroups(scope.db, scope.tenant_id);
    const memberships = await listTenantGroupMemberships(scope.db, scope.tenant_id);
    const members = new Map<string, string[]>();
    for (const membership of memberships) {
      const ids = members.get(membership.group_id) ?? [];
      ids.push(membership.user_id);
      members.set(membership.group_id, ids);
    }
    return { groups, members };
  },
  http: {
    method: "get",
    path: "/v1/rbac/groups",
    tags: TAGS,
    response: z.object({ items: z.array(RbacGroupDetailSchema) }).openapi("RbacGroupListResponse"),
    toInput: () => null,
    toBody: ({ groups, members }) => ({
      items: groups.map((group) => ({
        ...serializeGroup(group),
        member_count: members.get(group.id)?.length ?? 0,
        member_ids: members.get(group.id) ?? [],
      })),
    }),
  },
});

export const createGroupOperation = defineOperation<CreateNamed, GroupRow>({
  id: "rbac.group.create",
  summary: "Create a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const group = await createGroup(scope.db, scope.tenant_id, body.name, body.description);
    await audited(scope, principal, AuditAction.RBAC_GROUP_CREATED, "group", group.id, {
      name: group.name,
    });
    return group;
  },
  http: {
    method: "post",
    path: "/v1/rbac/groups",
    tags: TAGS,
    body: CreateGroupBody,
    bodyRequired: true,
    response: RbacGroupSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request" },
    toInput: ({ json }) => json as CreateNamed,
    toBody: serializeGroup,
  },
});

export const updateGroupOperation = defineOperation<UpdateInput, GroupRow>({
  id: "rbac.group.update",
  summary: "Update a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const group = await updateGroup(scope.db, scope.tenant_id, id, namedPatch(body));
    if (!group) return reject.notFound("group");
    await audited(scope, principal, AuditAction.RBAC_GROUP_UPDATED, "group", id, {
      patch: body,
    });
    return group;
  },
  http: {
    method: "patch",
    path: "/v1/rbac/groups/{id}",
    tags: TAGS,
    params: IdParam,
    body: UpdateGroupBody,
    bodyRequired: true,
    response: RbacGroupSchema,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ id: (param as IdInput).id, body: json as UpdateNamed }),
    toBody: serializeGroup,
  },
});

export const deleteGroupOperation = defineOperation<IdInput, Ok>({
  id: "rbac.group.delete",
  summary: "Delete a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await deleteGroup(scope.db, scope.tenant_id, id);
    if (!ok) return reject.notFound("group");
    await audited(scope, principal, AuditAction.RBAC_GROUP_DELETED, "group", id, {});
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/groups/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as IdInput).id }),
    toBody: () => null,
  },
});

function groupMemberInput(param: unknown): GroupMemberInput {
  const { id, user_id } = param as GroupMemberInput;
  return { id, user_id };
}

function groupRoleInput(param: unknown): GroupRoleInput {
  const { id, role_id } = param as GroupRoleInput;
  return { id, role_id };
}

export const addGroupMemberOperation = defineOperation<GroupMemberInput, Ok>({
  id: "rbac.group.member.add",
  summary: "Add a user to a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_MEMBER_ADDED,
  async handler(scope, { id, user_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const group = await getGroup(scope.db, scope.tenant_id, id);
    if (!group) return reject.notFound("group");
    const ok = await addMember(scope.db, scope.tenant_id, id, user_id, principal.id);
    if (!ok) return reject.notFound("member");
    await audited(scope, principal, AuditAction.RBAC_GROUP_MEMBER_ADDED, "group", id, {
      user_id,
    });
    return OK;
  },
  http: {
    method: "post",
    path: "/v1/rbac/groups/{id}/members/{user_id}",
    tags: TAGS,
    params: GroupMemberParams,
    response: OkResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => groupMemberInput(param),
    toBody: (ok) => ok,
  },
});

export const removeGroupMemberOperation = defineOperation<GroupMemberInput, Ok>({
  id: "rbac.group.member.remove",
  summary: "Remove a user from a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_MEMBER_REMOVED,
  async handler(scope, { id, user_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await removeMember(scope.db, scope.tenant_id, id, user_id);
    if (!ok) return reject.notFound("member");
    await audited(scope, principal, AuditAction.RBAC_GROUP_MEMBER_REMOVED, "group", id, {
      user_id,
    });
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/groups/{id}/members/{user_id}",
    tags: TAGS,
    params: GroupMemberParams,
    response: z.null(),
    success: { status: 204, description: "Removed" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => groupMemberInput(param),
    toBody: () => null,
  },
});

export const assignGroupRoleOperation = defineOperation<GroupRoleInput, Ok>({
  id: "rbac.group.role.assign",
  summary: "Assign a role to a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_ROLE_ASSIGNED,
  async handler(scope, { id, role_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const group = await getGroup(scope.db, scope.tenant_id, id);
    if (!group) return reject.notFound("group");
    const role = await getRole(scope.db, scope.tenant_id, role_id);
    if (!role) return reject.notFound("role");
    const ok = await assignRoleToGroup(scope.db, scope.tenant_id, id, role_id);
    if (!ok) return reject.notFound("group_role");
    await audited(scope, principal, AuditAction.RBAC_GROUP_ROLE_ASSIGNED, "group", id, {
      role_id,
    });
    return OK;
  },
  http: {
    method: "post",
    path: "/v1/rbac/groups/{id}/roles/{role_id}",
    tags: TAGS,
    params: GroupRoleParams,
    response: OkResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => groupRoleInput(param),
    toBody: (ok) => ok,
  },
});

export const revokeGroupRoleOperation = defineOperation<GroupRoleInput, Ok>({
  id: "rbac.group.role.revoke",
  summary: "Revoke a role from a group",
  permission: "rbac:write",
  effect: "write",
  audit: AuditAction.RBAC_GROUP_ROLE_REVOKED,
  async handler(scope, { id, role_id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const ok = await revokeRoleFromGroup(scope.db, scope.tenant_id, id, role_id);
    if (!ok) return reject.notFound("group_role");
    await audited(scope, principal, AuditAction.RBAC_GROUP_ROLE_REVOKED, "group", id, {
      role_id,
    });
    return OK;
  },
  http: {
    method: "delete",
    path: "/v1/rbac/groups/{id}/roles/{role_id}",
    tags: TAGS,
    params: GroupRoleParams,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => groupRoleInput(param),
    toBody: () => null,
  },
});

export const canOperation = defineOperation<CanInput, CanDecision>({
  id: "rbac.can",
  summary: "Check whether a principal holds a permission",
  permission: "rbac:read",
  effect: "read",
  async handler(scope, body) {
    const queryPrincipal = await buildQueryPrincipal(scope.db, scope.tenant_id, body.principal_id);
    if (!queryPrincipal) return reject.notFound("principal");
    const decision = await can(scope.db, {
      tenant_id: scope.tenant_id,
      principal: queryPrincipal,
      permission: body.permission,
      ...(body.resource ? { resource: body.resource } : {}),
    });
    return {
      allow: decision.allow,
      reason: decision.reason ?? null,
      source: decision.source ?? null,
    };
  },
  http: {
    method: "post",
    path: "/v1/rbac/can",
    tags: TAGS,
    body: CanBody,
    bodyRequired: true,
    response: RbacCanResponseSchema,
    errors: { 400: "Bad request", 404: "Not found" },
    toInput: ({ json }) => json as CanInput,
    toBody: (decision) => decision,
  },
});
