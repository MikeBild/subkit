// GET /v1/identity/users — admin; paginated.
// GET /v1/identity/users/:id — admin or self.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { policy } from "../../../auth/policy.ts";
import * as identity from "../../../identity/service.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { ErrorSchema, IdParam, PaginationQuery, paginatedResponse, UserSchema } from "./schemas.ts";

const UserListResponse = paginatedResponse(UserSchema, "UserListResponse");

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

function serialize(u: NonNullable<Awaited<ReturnType<typeof identity.getUser>>>) {
  return {
    id: u.id,
    tenant_id: u.tenant_id,
    email: u.email,
    role: u.role,
    created_at: u.created_at.toISOString(),
    updated_at: u.updated_at.toISOString(),
  };
}

export function registerUserRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC is enforced by the `requirePermission(...)` middleware below
  // (identity:read / identity:write). The legacy `enforce(adminOnly)`
  // calls inside the handlers are strict duplicates kept as defense-in-
  // depth — if the middleware is ever misconfigured the handler still
  // refuses non-admin access.
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
    return c.json({ items: items.map(serialize) }, 200);
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
    return c.json(serialize(u), 200);
  });
}
