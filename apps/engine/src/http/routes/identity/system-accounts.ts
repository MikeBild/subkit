import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, PaginationQuery } from "../../../api/common-schemas.ts";
import { policy } from "../../../auth/index.ts";
import * as identity from "../../../identity/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { enforce } from "../../middleware/policy.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { SystemAccountSchema } from "./schemas.ts";

const SystemAccountListResponse = z
  .object({ items: z.array(SystemAccountSchema) })
  .openapi("SystemAccountListResponse");

const CreateSystemAccountBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
  })
  .openapi("CreateSystemAccountBody");

const listRoute = createRoute({
  method: "get",
  path: "/v1/identity/system-accounts",
  tags: ["identity"],
  summary: "List system accounts",
  request: { query: PaginationQuery },
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SystemAccountListResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/identity/system-accounts",
  tags: ["identity"],
  summary: "Create a system account",
  request: {
    body: { content: { "application/json": { schema: CreateSystemAccountBody } } },
  },
  security: [{ bearerAuth: [] }],
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: SystemAccountSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/identity/system-accounts/{id}",
  tags: ["identity"],
  summary: "Delete a system account",
  request: { params: IdParam },
  security: [{ bearerAuth: [] }],
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function serialize(s: NonNullable<Awaited<ReturnType<typeof identity.createSystemAccount>>>) {
  return {
    id: s.id,
    tenant_id: s.tenant_id,
    name: s.name,
    description: s.description ?? null,
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
  };
}

export function registerSystemAccountRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/identity/system-accounts", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("identity:read")(c, next);
    if (c.req.method === "POST") return requirePermission("identity:write")(c, next);
    return next();
  });
  app.use("/v1/identity/system-accounts/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "DELETE") {
      return requirePermission("identity:write", () => ({ type: "system_account", id }))(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "system_account" }, db);
    const q = c.req.valid("query");
    const items = await identity.listSystemAccounts(
      principal.tenant_id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items: items.map(serialize) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "system_account" }, db);
    const body = c.req.valid("json");
    const row = await identity.createSystemAccount(
      {
        tenant_id: principal.tenant_id,
        name: body.name,
        description: body.description ?? null,
        actor_id: principal.id,
      },
      db,
    );
    return c.json(serialize(row), 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    enforce(principal, policy.adminOnly(principal), { resource_type: "system_account" }, db);
    const { id } = c.req.valid("param");
    const row = await identity.deleteSystemAccount(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
      },
      db,
    );
    if (!row) throw new NotFoundError("system_account");
    return c.body(null, 204);
  });
}
