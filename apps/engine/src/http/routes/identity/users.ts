import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ErrorSchema,
  IdParam,
  PaginationQuery,
  paginatedResponse,
} from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import {
  can,
  listTenantGroupMemberships,
  roleNameById,
  roleNamesById,
} from "../../../rbac/index.ts";
import { now } from "../../../utils/clock.ts";
import { ConflictError, LastAdminConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { UserDetailSchema, UserSchema } from "./schemas.ts";

const UserListResponse = paginatedResponse(UserDetailSchema, "UserListResponse").extend({
  total: z.number().int().nonnegative(),
});

const CreateUserBody = z
  .object({
    email: z.string().email().min(3).max(254),
    display_name: z.string().trim().min(1).max(120).nullable().optional(),
    role: z.enum(["admin", "member", "enduser"]).optional(),
  })
  .openapi("CreateUserBody");

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

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/users",
  tags: ["identity"],
  summary: "List users in the caller's tenant",
  request: { query: UserListQuery },
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: UserListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/identity/users/{id}",
  tags: ["identity"],
  summary: "Fetch a user",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: UserDetailSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/v1/identity/users",
  tags: ["identity"],
  summary: "Create a user in the caller's tenant",
  request: { body: { content: { "application/json": { schema: CreateUserBody } } } },
  security: [{ bearerAuth: [] }],
  responses: {
    201: { description: "Created", content: { "application/json": { schema: UserSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Duplicate email",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/v1/identity/users/{id}",
  tags: ["identity"],
  summary: "Update a user's profile or role",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateUserBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: UserSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "last_admin — the change would leave the workspace without an administrator",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deactivateRoute = createRoute({
  method: "delete",
  path: "/v1/identity/users/{id}",
  tags: ["identity"],
  summary: "Deactivate a user (soft delete + revoke their API keys)",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Deactivated" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "last_admin — the workspace's last administrator cannot be deactivated",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function lastAdminAsConflict(err: unknown): never {
  if (err instanceof identity.LastAdminError) throw new LastAdminConflictError(err.message);
  throw err;
}

async function identitiesByUser(
  db: Parameters<typeof identity.listIdentitiesByUser>[0],
  tenantId: string,
  userIds: string[],
) {
  const rows = await identity.listIdentitiesByUser(db, tenantId, userIds);
  const result = new Map<
    string,
    { provider_id: string; product_id: string | null; last_seen_at: string }[]
  >();
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

function serialize(
  u: NonNullable<Awaited<ReturnType<typeof identity.getUser>>>,
  roleName: string | null,
  oauthConnections = 0,
) {
  return {
    id: u.id,
    tenant_id: u.tenant_id,
    email: u.email,
    display_name: u.display_name,
    role: roleName,
    status: u.status,
    oauth_connections: oauthConnections,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
  };
}

export function registerUserRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/users", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("identity:read")(c, next);
    if (c.req.method === "POST") return requirePermission("identity:write")(c, next);
    return next();
  });
  app.use("/v1/identity/users/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("identity:read", () => ({ type: "user", id }))(c, next);
    }
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requirePermission("identity:write", () => ({ type: "user", id }))(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user" }, db);
    const q = c.req.valid("query");
    const [items, total] = await Promise.all([
      identity.listUsers(
        principal.tenant_id,
        {
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.offset !== undefined ? { offset: q.offset } : {}),
          ...(q.product_id !== undefined ? { productId: q.product_id } : {}),
        },
        db,
      ),
      identity.countUsers(
        principal.tenant_id,
        db,
        q.product_id !== undefined ? { productId: q.product_id } : {},
      ),
    ]);
    const roleNames = await roleNamesById(db, principal.tenant_id);
    const connections = await identity.countLiveConnectionsByUser(
      db,
      principal.tenant_id,
      new Date(now()),
    );
    const canReadGroups = (
      await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "rbac:read",
        quiet: true,
      })
    ).allow;
    const memberships = canReadGroups
      ? await listTenantGroupMemberships(
          db,
          principal.tenant_id,
          items.map((user) => user.id),
        )
      : [];
    const identities = await identitiesByUser(
      db,
      principal.tenant_id,
      items.map((user) => user.id),
    );
    const groupsByUser = new Map<string, { id: string; name: string }[]>();
    for (const membership of memberships) {
      const groups = groupsByUser.get(membership.user_id) ?? [];
      groups.push({ id: membership.group_id, name: membership.group_name });
      groupsByUser.set(membership.user_id, groups);
    }
    return c.json(
      {
        items: items.map((user) => ({
          ...serialize(user, roleNames.get(user.role_id) ?? null, connections.get(user.id) ?? 0),
          groups: canReadGroups ? (groupsByUser.get(user.id) ?? []) : null,
          identities: identities.get(user.id) ?? [],
        })),
        total,
      },
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const selfMatch = principal.kind === "user" && principal.id === id;
    enforce(
      principal,
      policy.adminOrSelf(principal, selfMatch),
      {
        resource_type: "user",
        resource_id: id,
      },
      db,
    );
    const u = await identity.getUser(principal.tenant_id, id, db);
    if (!u) throw new NotFoundError("user");
    const connections = await identity.countLiveConnectionsByUser(
      db,
      principal.tenant_id,
      new Date(now()),
    );
    const roleName = await roleNameById(db, principal.tenant_id, u.role_id);
    const canReadGroups = (
      await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "rbac:read",
        quiet: true,
      })
    ).allow;
    const memberships = canReadGroups
      ? await listTenantGroupMemberships(db, principal.tenant_id, [u.id])
      : [];
    const identities = await identitiesByUser(db, principal.tenant_id, [u.id]);
    return c.json(
      {
        ...serialize(u, roleName, connections.get(u.id) ?? 0),
        groups: canReadGroups
          ? memberships.map((membership) => ({
              id: membership.group_id,
              name: membership.group_name,
            }))
          : null,
        identities: identities.get(u.id) ?? [],
      },
      200,
    );
  });

  app.openapi(createRoute_, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user" }, db);
    const body = c.req.valid("json");
    try {
      const u = await identity.createUser(
        {
          tenant_id: principal.tenant_id,
          email: body.email,
          ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
          ...(body.role ? { role: body.role } : {}),
          actor_kind: principal.kind,
          actor_id: principal.id,
        },
        db,
      );
      return c.json(serialize(u, body.role ?? "member"), 201);
    } catch (err) {
      if (err instanceof identity.DuplicateUserError) throw new ConflictError(err.message);
      throw err;
    }
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    enforce(
      principal,
      policy.adminOnly(principal),
      { resource_type: "user", action: "update", resource_id: id },
      db,
    );
    const u = await identity
      .updateUser(
        {
          tenant_id: principal.tenant_id,
          id,
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.display_name !== undefined ? { display_name: body.display_name } : {}),
          actor_kind: principal.kind,
          actor_id: principal.id,
        },
        db,
      )
      .catch(lastAdminAsConflict);
    if (!u) throw new NotFoundError("user");
    const roleName = await roleNameById(db, principal.tenant_id, u.role_id);
    return c.json(serialize(u, roleName), 200);
  });

  app.openapi(deactivateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user", resource_id: id }, db);
    const u = await identity
      .deactivateUser(
        {
          tenant_id: principal.tenant_id,
          user_id: id,
          actor_kind: principal.kind,
          actor_id: principal.id,
        },
        db,
      )
      .catch(lastAdminAsConflict);
    if (!u) throw new NotFoundError("user");
    return c.body(null, 204);
  });
}
