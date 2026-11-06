import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import {
  createRequestHook,
  deleteRequestHook,
  findRequestHook,
  lintHookSource,
  listRequestHooks,
  policy,
  type RequestHookRow,
  updateRequestHook,
} from "../../auth/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const HookSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    role: z.string(),
    source: z.string(),
    description: z.string().nullable(),
    version: z.number().int(),
    enabled: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("RequestHook");

const ListResponse = paginatedResponse(HookSchema, "RequestHookListResponse");

const CreateBody = z
  .object({
    role: z.string().min(1),
    code: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("CreateRequestHookBody");

const UpdateBody = z
  .object({
    code: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("UpdateRequestHookBody");

function serialize(row: RequestHookRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    role: row.role,
    source: row.source,
    description: row.description ?? null,
    version: row.version,
    enabled: row.enabled,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/auth/request-hooks",
  tags: ["auth"],
  summary: "List request hooks",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/auth/request-hooks",
  tags: ["auth"],
  summary: "Create a request hook",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: HookSchema } } },
    400: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/auth/request-hooks/{id}",
  tags: ["auth"],
  summary: "Update a request hook",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: HookSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRouteSpec = createRoute({
  method: "delete",
  path: "/v1/auth/request-hooks/{id}",
  tags: ["auth"],
  summary: "Delete a request hook",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function requireAdmin(principal: import("../../auth/types.ts").ResolvedPrincipal): void {
  const decision = policy.adminOnly(principal);
  if (!decision.allowed) throw new ForbiddenError(decision.reason ?? "admin_required");
}

export function registerRequestHookRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/auth/request-hooks", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("rbac:read")(c, next);
    if (c.req.method === "POST") return requirePermission("rbac:write")(c, next);
    return next();
  });
  app.use("/v1/auth/request-hooks/:id", async (c, next) => {
    if (c.req.method === "PATCH" || c.req.method === "DELETE") {
      return requirePermission("rbac:write")(c, next);
    }
    return next();
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const rows = await listRequestHooks(c.get("db"), principal.tenant_id);
    return c.json({ items: rows.map(serialize) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const body = c.req.valid("json");
    const lint = await lintHookSource(body.code);
    if (!lint.ok) {
      throw new BadRequestError("invalid hook source", { reason: lint.error });
    }
    const row = await createRequestHook(
      c.get("db"),
      { principal, trace_id: c.get("trace_id") ?? "" },
      body,
    );
    return c.json(serialize(row), 201);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const cur = await findRequestHook(db, principal.tenant_id, id);
    if (!cur) throw new NotFoundError("request_hook");
    if (body.code !== undefined) {
      const lint = await lintHookSource(body.code);
      if (!lint.ok) {
        throw new BadRequestError("invalid hook source", { reason: lint.error });
      }
    }
    const row = await updateRequestHook(
      db,
      { principal, trace_id: c.get("trace_id") ?? "" },
      cur,
      body,
    );
    if (!row) throw new NotFoundError("request_hook");
    return c.json(serialize(row), 200);
  });

  app.openapi(deleteRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const { id } = c.req.valid("param");
    const row = await deleteRequestHook(
      c.get("db"),
      { principal, trace_id: c.get("trace_id") ?? "" },
      id,
    );
    if (!row) throw new NotFoundError("request_hook");
    return c.json({ deleted: true }, 200);
  });
}
