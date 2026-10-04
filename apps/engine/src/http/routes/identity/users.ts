// GET /v1/identity/users — admin; paginated.
// GET /v1/identity/users/:id — admin or self.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  ErrorSchema,
  IdParam,
  PaginationQuery,
  paginatedResponse,
} from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import { roles } from "../../../db/schema/index.ts";
import * as identity from "../../../identity/index.ts";
import { now } from "../../../utils/clock.ts";
import { ConflictError, LastAdminConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { UserSchema } from "./schemas.ts";

const UserListResponse = paginatedResponse(UserSchema, "UserListResponse");

const CreateUserBody = z
  .object({
    email: z.string().email().min(3).max(254),
    role: z.enum(["admin", "member", "enduser"]).optional(),
  })
  .openapi("CreateUserBody");

const UpdateUserBody = z
  .object({
    role: z.enum(["admin", "member", "enduser"]),
  })
  .openapi("UpdateUserBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/users",
  tags: ["identity"],
  summary: "List users in the caller's tenant",
  request: { query: PaginationQuery },
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
    200: { description: "OK", content: { "application/json": { schema: UserSchema } } },
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
  summary: "Update a user's role",
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

/** The domain's last-admin refusal as the 409 a client can name. */
function lastAdminAsConflict(err: unknown): never {
  if (err instanceof identity.LastAdminError) throw new LastAdminConflictError(err.message);
  throw err;
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
    role: roleName,
    status: u.status,
    oauth_connections: oauthConnections,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
  };
}

export function registerUserRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC is enforced by the `requirePermission(...)` middleware below
  // (identity:read / identity:write) AND a handler-level `enforce(...)`
  // check. The two are NOT redundant: the middleware proves the principal
  // holds the named permission, while the handler pins the role floor each
  // mutation actually requires. Mutations that change another user's
  // authority (create, update role, deactivate) demand `adminOnly`; only
  // the read GET relaxes to `adminOrSelf`. Collapsing these to a single
  // identity:write gate would let any holder of that permission escalate
  // their own role — which is exactly why the PATCH handler is adminOnly.
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
    const items = await identity.listUsers(
      principal.tenant_id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    const roleRows = await db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(or(isNull(roles.tenant_id), eq(roles.tenant_id, principal.tenant_id)));
    const roleNames = new Map(roleRows.map((role) => [role.id, role.name]));
    // The People page asks "deactivate?" — it may as well say what that ends.
    const connections = await identity.countLiveConnectionsByUser(
      db,
      principal.tenant_id,
      new Date(now()),
    );
    return c.json(
      {
        items: items.map((user) =>
          serialize(user, roleNames.get(user.role_id) ?? null, connections.get(user.id) ?? 0),
        ),
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
    const [role] = await db
      .select({ name: roles.name })
      .from(roles)
      .where(
        and(
          eq(roles.id, u.role_id),
          or(isNull(roles.tenant_id), eq(roles.tenant_id, principal.tenant_id)),
        ),
      )
      .limit(1);
    return c.json(serialize(u, role?.name ?? null, connections.get(u.id) ?? 0), 200);
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
          ...(body.role ? { role: body.role } : {}),
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
        { tenant_id: principal.tenant_id, id, role: body.role, actor_id: principal.id },
        db,
      )
      .catch(lastAdminAsConflict);
    if (!u) throw new NotFoundError("user");
    return c.json(serialize(u, body.role), 200);
  });

  app.openapi(deactivateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    enforce(principal, policy.adminOnly(principal), { resource_type: "user", resource_id: id }, db);
    const u = await identity
      .deactivateUser({ tenant_id: principal.tenant_id, user_id: id, actor_id: principal.id }, db)
      .catch(lastAdminAsConflict);
    if (!u) throw new NotFoundError("user");
    return c.body(null, 204);
  });
}
