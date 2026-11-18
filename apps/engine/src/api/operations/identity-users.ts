import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import type { Db } from "../../db/client.ts";
import { enforce } from "../../http/middleware/policy.ts";
import { LastAdminError } from "../../identity/last-admin.ts";
import { countLiveConnectionsByUser } from "../../identity/oauth-connections.ts";
import {
  bindProviderIdentity,
  ProviderIdentityBindingError,
} from "../../identity/provider-identities.ts";
import {
  createInvite,
  createInvitedUser,
  createUser,
  DuplicateUserError,
  deactivateUser,
  listInvites,
  revokeInvite,
} from "../../identity/provisioning.ts";
import {
  countUsers,
  getTenant,
  getUser,
  listIdentitiesByUser,
  listTenantsForPrincipal,
  listUsers,
  updateUser,
} from "../../identity/service.ts";
import { can } from "../../rbac/evaluator.ts";
import { listTenantGroupMemberships } from "../../rbac/groups.ts";
import { roleNameById, roleNamesById } from "../../rbac/role-names.ts";
import { now } from "../../utils/clock.ts";
import { IdParam, PaginationQuery, paginatedResponse } from "../common-schemas.ts";
import {
  serializeInvite,
  serializeTenant,
  serializeUser,
  TenantSchema,
  UserDetailSchema,
  UserInviteIssuedSchema,
  UserInviteSchema,
  UserSchema,
} from "./identity-representation.ts";
import { defineOperation, type OperationScope, type Rejection, reject } from "./index.ts";

const TAGS = ["identity"] as const;
const UNAUTHORIZED = "Unauthorized";
const FORBIDDEN = "Forbidden";

interface IdInput {
  readonly id: string;
}

const idInput = ({ param }: { param: unknown }): IdInput => ({ id: (param as IdInput).id });

const TenantListResponse = paginatedResponse(TenantSchema, "TenantListResponse");

type TenantRow = NonNullable<Awaited<ReturnType<typeof getTenant>>>;
type UserRow = NonNullable<Awaited<ReturnType<typeof getUser>>>;

export const listTenantsOperation = defineOperation<null, TenantRow[]>({
  id: "identity.tenant.list",
  summary: "List tenants visible to the caller",
  permission: "identity:read",
  effect: "read",
  async handler(scope) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "tenant" },
      scope.db,
    );
    return listTenantsForPrincipal(scope.tenant_id, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/identity/tenants",
    tags: TAGS,
    response: TenantListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: () => null,
    toBody: (items) => ({ items: items.map(serializeTenant) }),
  },
});

export const getTenantOperation = defineOperation<IdInput, TenantRow>({
  id: "identity.tenant.get",
  summary: "Fetch a tenant",
  permission: "identity:read",
  effect: "read",
  async handler(scope, { id }) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "tenant" },
      scope.db,
    );
    if (id !== scope.tenant_id) return reject.notFound("tenant");
    const tenant = await getTenant(id, scope.db);
    if (!tenant) return reject.notFound("tenant");
    return tenant;
  },
  http: {
    method: "get",
    path: "/v1/identity/tenants/{id}",
    tags: TAGS,
    params: IdParam,
    response: TenantSchema,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: serializeTenant,
  },
});

const UserListResponse = paginatedResponse(UserDetailSchema, "UserListResponse").extend({
  total: z.number().int().nonnegative(),
});

const CreateUserBody = z
  .object({
    email: z.string().email().min(3).max(254),
    display_name: z.string().trim().min(1).max(120).nullable().optional(),
    role: z.enum(["admin", "member", "enduser"]).optional(),
    invite: z
      .object({
        ttl_minutes: z
          .number()
          .int()
          .positive()
          .max(90 * 24 * 60)
          .optional(),
      })
      .strict()
      .optional()
      .describe(
        "Create the person as invited and issue their single-use invitation in the same step. Omitted: the person is active at once.",
      ),
  })
  .openapi("CreateUserBody");

const UserCreatedSchema = UserSchema.extend({
  invite: UserInviteIssuedSchema.optional().describe(
    "The invitation issued with this person, present only when the request asked for one. Its plaintext_token is shown once.",
  ),
}).openapi("UserCreated");

const UpdateUserBody = z
  .union([
    z.object({
      role: z.enum(["admin", "member", "enduser"]),
      display_name: z.string().trim().min(1).max(120).nullable().optional(),
    }),
    z.object({
      role: z.enum(["admin", "member", "enduser"]).optional(),
      display_name: z.string().trim().min(1).max(120).nullable(),
    }),
  ])
  .openapi("UpdateUserBody");

const UserListQuery = PaginationQuery.extend({
  product_id: z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional()
    .describe("Only users with a sign-in identity for this app"),
});

type UserListInput = z.infer<typeof UserListQuery>;
type CreateUserInput = z.infer<typeof CreateUserBody>;
type UpdateUserInput = IdInput & { readonly body: z.infer<typeof UpdateUserBody> };

interface UserIdentity {
  readonly provider_id: string;
  readonly product_id: string | null;
  readonly last_seen_at: string;
}

interface UserGroup {
  readonly id: string;
  readonly name: string;
}

async function identitiesByUser(
  db: Db,
  tenantId: string,
  userIds: string[],
): Promise<Map<string, UserIdentity[]>> {
  const rows = await listIdentitiesByUser(db, tenantId, userIds);
  const result = new Map<string, UserIdentity[]>();
  for (const row of rows) {
    result.set(row.user_id, [
      ...(result.get(row.user_id) ?? []),
      {
        provider_id: row.provider_id,
        product_id: row.product_id,
        last_seen_at: row.last_seen_at.toISOString(),
      },
    ]);
  }
  return result;
}

async function canReadGroups(scope: OperationScope): Promise<boolean> {
  if (!scope.principal) return false;
  return (
    await can(scope.db, {
      tenant_id: scope.tenant_id,
      principal: scope.principal,
      permission: "rbac:read",
      quiet: true,
    })
  ).allow;
}

function lastAdminRejection(err: unknown): Rejection {
  if (err instanceof LastAdminError) return reject.conflict(err.message, undefined, "last_admin");
  throw err;
}

interface UserListResult {
  readonly items: UserRow[];
  readonly total: number;
  readonly roleNames: Map<string, string>;
  readonly connections: Map<string, number>;
  readonly groups: Map<string, UserGroup[]> | null;
  readonly identities: Map<string, UserIdentity[]>;
}

export const listUsersOperation = defineOperation<UserListInput, UserListResult>({
  id: "identity.user.list",
  summary: "List users in the caller's tenant",
  permission: "identity:read",
  effect: "read",
  async handler(scope, q) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "user" },
      scope.db,
    );
    const [items, total] = await Promise.all([
      listUsers(
        scope.tenant_id,
        {
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.offset !== undefined ? { offset: q.offset } : {}),
          ...(q.product_id !== undefined ? { productId: q.product_id } : {}),
        },
        scope.db,
      ),
      countUsers(
        scope.tenant_id,
        scope.db,
        q.product_id !== undefined ? { productId: q.product_id } : {},
      ),
    ]);
    const roleNames = await roleNamesById(scope.db, scope.tenant_id);
    const connections = await countLiveConnectionsByUser(
      scope.db,
      scope.tenant_id,
      new Date(now()),
    );
    const readGroups = await canReadGroups(scope);
    const memberships = readGroups
      ? await listTenantGroupMemberships(
          scope.db,
          scope.tenant_id,
          items.map((user) => user.id),
        )
      : [];
    const identities = await identitiesByUser(
      scope.db,
      scope.tenant_id,
      items.map((user) => user.id),
    );
    const groups = new Map<string, UserGroup[]>();
    for (const membership of memberships) {
      const list = groups.get(membership.user_id) ?? [];
      list.push({ id: membership.group_id, name: membership.group_name });
      groups.set(membership.user_id, list);
    }
    return { items, total, roleNames, connections, groups: readGroups ? groups : null, identities };
  },
  http: {
    method: "get",
    path: "/v1/identity/users",
    tags: TAGS,
    query: UserListQuery,
    response: UserListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: ({ query }) => query as UserListInput,
    toBody: ({ items, total, roleNames, connections, groups, identities }) => ({
      items: items.map((user) => ({
        ...serializeUser(user, roleNames.get(user.role_id) ?? null, connections.get(user.id) ?? 0),
        groups: groups ? (groups.get(user.id) ?? []) : null,
        identities: identities.get(user.id) ?? [],
      })),
      total,
    }),
  },
});

interface UserDetailResult {
  readonly user: UserRow;
  readonly roleName: string | null;
  readonly connections: number;
  readonly groups: UserGroup[] | null;
  readonly identities: UserIdentity[];
}

export const getUserOperation = defineOperation<IdInput, UserDetailResult>({
  id: "identity.user.get",
  summary: "Fetch a user",
  permission: "identity:read",
  resource: { type: "user", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const selfMatch = principal.kind === "user" && principal.id === id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      { resource_type: "user", resource_id: id },
      scope.db,
    );
    const user = await getUser(scope.tenant_id, id, scope.db);
    if (!user) return reject.notFound("user");
    const connections = await countLiveConnectionsByUser(
      scope.db,
      scope.tenant_id,
      new Date(now()),
    );
    const roleName = await roleNameById(scope.db, scope.tenant_id, user.role_id);
    const readGroups = await canReadGroups(scope);
    const memberships = readGroups
      ? await listTenantGroupMemberships(scope.db, scope.tenant_id, [user.id])
      : [];
    const identities = await identitiesByUser(scope.db, scope.tenant_id, [user.id]);
    return {
      user,
      roleName,
      connections: connections.get(user.id) ?? 0,
      groups: readGroups
        ? memberships.map((membership) => ({
            id: membership.group_id,
            name: membership.group_name,
          }))
        : null,
      identities: identities.get(user.id) ?? [],
    };
  },
  http: {
    method: "get",
    path: "/v1/identity/users/{id}",
    tags: TAGS,
    params: IdParam,
    response: UserDetailSchema,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: ({ user, roleName, connections, groups, identities }) => ({
      ...serializeUser(user, roleName, connections),
      groups,
      identities,
    }),
  },
});

interface UserResult {
  readonly user: UserRow;
  readonly roleName: string | null;
}

type InviteIssued = Awaited<ReturnType<typeof createInvite>>;

interface UserCreatedResult extends UserResult {
  readonly invite?: InviteIssued;
}

export const createUserOperation = defineOperation<CreateUserInput, UserCreatedResult>({
  id: "identity.user.create",
  summary: "Create a user in the caller's tenant",
  permission: "identity:write",
  effect: "write",
  audit: AuditAction.USER_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(principal, policy.adminOnly(principal), { resource_type: "user" }, scope.db);
    const person = {
      tenant_id: scope.tenant_id,
      email: body.email,
      ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
      ...(body.role ? { role: body.role } : {}),
      actor_kind: principal.kind,
      actor_id: principal.id,
    };
    try {
      if (body.invite) {
        const created = await createInvitedUser(
          {
            ...person,
            issuer: { kind: "principal", principal },
            ...(body.invite.ttl_minutes !== undefined
              ? { ttl_minutes: body.invite.ttl_minutes }
              : {}),
          },
          scope.db,
        );
        return { user: created.user, roleName: body.role ?? "member", invite: created.invite };
      }
      const user = await createUser(person, scope.db);
      return { user, roleName: body.role ?? "member" };
    } catch (err) {
      if (err instanceof DuplicateUserError) return reject.conflict(err.message);
      throw err;
    }
  },
  http: {
    method: "post",
    path: "/v1/identity/users",
    tags: TAGS,
    body: CreateUserBody,
    response: UserCreatedSchema,
    success: { status: 201, description: "Created" },
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 409: "Duplicate email" },
    toInput: ({ json }) => json as CreateUserInput,
    toBody: ({ user, roleName, invite }) => ({
      ...serializeUser(user, roleName),
      ...(invite
        ? { invite: { ...serializeInvite(invite.view), plaintext_token: invite.plaintext } }
        : {}),
    }),
  },
});

export const updateUserOperation = defineOperation<UpdateUserInput, UserResult>({
  id: "identity.user.update",
  summary: "Update a user's profile or role",
  permission: "identity:write",
  resource: { type: "user", param: "id" },
  effect: "write",
  audit: AuditAction.USER_PROFILE_UPDATED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user", action: "update", resource_id: id },
      scope.db,
    );
    let user: Awaited<ReturnType<typeof updateUser>>;
    try {
      user = await updateUser(
        {
          tenant_id: scope.tenant_id,
          id,
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
          actor_kind: principal.kind,
          actor_id: principal.id,
        },
        scope.db,
      );
    } catch (err) {
      return lastAdminRejection(err);
    }
    if (!user) return reject.notFound("user");
    return { user, roleName: await roleNameById(scope.db, scope.tenant_id, user.role_id) };
  },
  http: {
    method: "patch",
    path: "/v1/identity/users/{id}",
    tags: TAGS,
    params: IdParam,
    body: UpdateUserBody,
    response: UserSchema,
    errors: {
      401: UNAUTHORIZED,
      403: FORBIDDEN,
      404: "Not found",
      409: "last_admin — the change would leave the workspace without an administrator",
    },
    toInput: ({ param, json }) => ({
      id: (param as IdInput).id,
      body: json as z.infer<typeof UpdateUserBody>,
    }),
    toBody: ({ user, roleName }) => serializeUser(user, roleName),
  },
});

export const deactivateUserOperation = defineOperation<IdInput, true>({
  id: "identity.user.deactivate",
  summary:
    "Deactivate a user (soft delete + revoke their API keys); a person who was invited and never joined is removed together with the invitation, so the address can be invited again",
  permission: "identity:write",
  resource: { type: "user", param: "id" },
  effect: "write",
  audit: AuditAction.USER_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user", resource_id: id },
      scope.db,
    );
    let user: Awaited<ReturnType<typeof deactivateUser>>;
    try {
      user = await deactivateUser(
        {
          tenant_id: scope.tenant_id,
          user_id: id,
          actor_kind: principal.kind,
          actor_id: principal.id,
        },
        scope.db,
      );
    } catch (err) {
      return lastAdminRejection(err);
    }
    if (!user) return reject.notFound("user");
    return true;
  },
  http: {
    method: "delete",
    path: "/v1/identity/users/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Deactivated" },
    errors: {
      401: UNAUTHORIZED,
      403: FORBIDDEN,
      404: "Not found",
      409: "last_admin — the workspace's last administrator cannot be deactivated",
    },
    toInput: idInput,
    toBody: () => null,
  },
});

const BindingBody = z
  .object({
    provider_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    subject: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          value.trim() === value &&
          !Array.from(value).some((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      ),
  })
  .strict();

const BindingResponse = z
  .object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    provider_id: z.string(),
    issuer_url: z.string(),
    product_id: z.string().nullable(),
    subject: z.string(),
    replayed: z.boolean(),
  })
  .strict()
  .openapi("ProviderIdentityBinding");

type BindingInput = IdInput & { readonly body: z.infer<typeof BindingBody> };
type Binding = z.infer<typeof BindingResponse>;

function bindingStatus(code: string): 400 | 403 | 404 | 409 {
  if (code === "provider_unavailable") return 400;
  if (code === "provider_tenant_mismatch") return 403;
  if (code === "user_unavailable") return 404;
  return 409;
}

export const bindProviderIdentityOperation = defineOperation<BindingInput, Binding>({
  id: "identity.user.provider_identity.bind",
  summary: "Bind a configured OIDC subject to an existing user",
  permission: "identity:write",
  resource: { type: "user", param: "id" },
  effect: "write",
  audit: AuditAction.USER_IDENTITY_LINKED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user", resource_id: id },
      scope.db,
    );
    try {
      const result = await bindProviderIdentity(
        {
          tenant_id: scope.tenant_id,
          user_id: id,
          ...body,
          actor_id: principal.id,
          actor_kind: principal.kind,
          request_source: scope.request_source ?? "api",
        },
        scope.db,
      );
      if (!result.binding.issuer_url) throw new Error("identity binding issuer missing");
      return {
        id: result.binding.id,
        user_id: result.binding.user_id,
        provider_id: result.binding.provider_id,
        issuer_url: result.binding.issuer_url,
        product_id: result.binding.product_id,
        subject: result.binding.subject,
        replayed: result.replayed,
      };
    } catch (error) {
      if (!(error instanceof ProviderIdentityBindingError)) throw error;
      return reject.status(bindingStatus(error.code), error.code, error.message);
    }
  },
  http: {
    method: "post",
    path: "/v1/identity/users/{id}/provider-identities",
    tags: TAGS,
    description:
      "Operator-only. Issuer, product and tenant derive from trusted provider configuration. Does not change roles or grants, reassign identities, or revoke existing sessions.",
    params: IdParam,
    body: BindingBody,
    response: BindingResponse,
    success: [
      { status: 200, description: "Existing exact binding" },
      { status: 201, description: "Binding created or legacy binding pinned" },
    ],
    statusFor: (binding) => (binding.replayed ? 200 : 201),
    errors: {
      400: "Invalid or unavailable provider",
      401: UNAUTHORIZED,
      403: "Forbidden or provider tenant mismatch",
      404: "Active user unavailable",
      409: "Subject, owner, issuer or product conflict",
    },
    toInput: ({ param, json }) => ({
      id: (param as IdInput).id,
      body: json as z.infer<typeof BindingBody>,
    }),
    toBody: (binding) => binding,
  },
});

const CreateInviteBody = z
  .object({
    scopes: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe(
        "Permission names from GET /v1/rbac/permissions, '*', or mcp:read, mcp:authoring, mcp:admin. Each must be held by the issuing credential; '*' only from a credential without scope limits. Omitted: the issuer's own ceiling.",
      ),
    allowed_workflows: z.array(z.string()).optional(),
    allowed_connectors: z.array(z.string()).optional(),
    ttl_minutes: z
      .number()
      .int()
      .positive()
      .max(90 * 24 * 60)
      .optional(),
  })
  .openapi("CreateInviteBody");

const InviteListResponse = z
  .object({ items: z.array(UserInviteSchema) })
  .openapi("UserInviteListResponse");

const InviteListQuery = z.object({
  status: z.enum(["pending", "redeemed", "revoked", "expired"]).optional(),
});

type CreateInviteInput = IdInput & { readonly body: z.infer<typeof CreateInviteBody> };
type InviteListInput = z.infer<typeof InviteListQuery>;
type InviteRow = InviteIssued["view"];

export const createInviteOperation = defineOperation<CreateInviteInput, InviteIssued>({
  id: "identity.user.invite.create",
  summary: "Issue a single-use provisioning invite for a user",
  permission: "identity:write",
  effect: "write",
  audit: AuditAction.USER_INVITED,
  async handler(scope, { id, body }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user_invite", resource_id: id },
      scope.db,
    );
    const user = await getUser(scope.tenant_id, id, scope.db);
    if (!user) return reject.notFound("user");
    return createInvite(
      {
        issuer: { kind: "principal", principal },
        tenant_id: scope.tenant_id,
        user_id: id,
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.allowed_workflows ? { allowed_workflows: body.allowed_workflows } : {}),
        ...(body.allowed_connectors ? { allowed_connectors: body.allowed_connectors } : {}),
        ...(body.ttl_minutes !== undefined ? { ttl_minutes: body.ttl_minutes } : {}),
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/identity/users/{id}/invites",
    tags: TAGS,
    params: IdParam,
    body: CreateInviteBody,
    response: UserInviteIssuedSchema,
    success: { status: 201, description: "Created; plaintext invite token returned once" },
    errors: {
      401: UNAUTHORIZED,
      403: "Forbidden, or scope_exceeds_issuer when a requested scope is not held by you",
      404: "User not found",
      422: "unknown_scope: a requested scope is not a permission name",
    },
    toInput: ({ param, json }) => ({
      id: (param as IdInput).id,
      body: json as z.infer<typeof CreateInviteBody>,
    }),
    toBody: (result) => ({ ...serializeInvite(result.view), plaintext_token: result.plaintext }),
  },
});

export const listInvitesOperation = defineOperation<InviteListInput, InviteRow[]>({
  id: "identity.invite.list",
  summary: "List invites in the caller's tenant",
  permission: "identity:read",
  effect: "read",
  async handler(scope, q) {
    if (!scope.principal) return reject.unauthorized();
    enforce(
      scope.principal,
      policy.adminOnly(scope.principal),
      { resource_type: "user_invite" },
      scope.db,
    );
    return listInvites(scope.tenant_id, q.status ? { status: q.status } : {}, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/identity/invites",
    tags: TAGS,
    query: InviteListQuery,
    response: InviteListResponse,
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN },
    toInput: ({ query }) => query as InviteListInput,
    toBody: (items) => ({ items: items.map(serializeInvite) }),
  },
});

export const revokeInviteOperation = defineOperation<IdInput, true>({
  id: "identity.invite.revoke",
  summary: "Revoke an un-redeemed invite",
  permission: "identity:write",
  resource: { type: "user_invite", param: "id" },
  effect: "write",
  audit: AuditAction.INVITE_REVOKED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user_invite", resource_id: id },
      scope.db,
    );
    const row = await revokeInvite(
      {
        tenant_id: scope.tenant_id,
        invite_id: id,
        actor_kind: principal.kind,
        actor_id: principal.id,
      },
      scope.db,
    );
    if (!row) return reject.notFound("user_invite");
    return true;
  },
  http: {
    method: "delete",
    path: "/v1/identity/invites/{id}",
    tags: TAGS,
    params: IdParam,
    response: z.null(),
    success: { status: 204, description: "Revoked" },
    errors: { 401: UNAUTHORIZED, 403: FORBIDDEN, 404: "Not found" },
    toInput: idInput,
    toBody: () => null,
  },
});
