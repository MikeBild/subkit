// Admin CRUD for Before-Request Hooks.
//
// Stored in the `request_hooks` table (tenant-scoped, keyed by role).
// Every mutation writes an audit row and lints the JavaScript source
// via the QuickJS sandbox so a malformed hook cannot reach the
// evaluation path.
//
//   GET    /v1/auth/request-hooks          — list
//   POST   /v1/auth/request-hooks          — create
//   PATCH  /v1/auth/request-hooks/:id      — update
//   DELETE /v1/auth/request-hooks/:id      — delete

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import { lintHookSource } from "../../auth/hooks.ts";
import { policy } from "../../auth/policy.ts";
import { writeAudit } from "../../db/audit.ts";
import { requestHooks } from "../../db/schema/request_hooks.ts";
import { STDLIB_VERSION } from "../../sandboxes/quickjs/stdlib/index.ts";
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

function serialize(row: typeof requestHooks.$inferSelect) {
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
  // RBAC: request hooks sit under rbac:read/rbac:write since they shape
  // the effective principal evaluated by the auth layer.
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
    const db = c.get("db");
    const rows = await db
      .select()
      .from(requestHooks)
      .where(eq(requestHooks.tenant_id, principal.tenant_id));
    return c.json({ items: rows.map(serialize) }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const body = c.req.valid("json");
    const lint = await lintHookSource(body.code);
    if (!lint.ok) {
      throw new BadRequestError("invalid hook source", { reason: lint.error });
    }
    const [row] = await db
      .insert(requestHooks)
      .values({
        tenant_id: principal.tenant_id,
        role: body.role,
        source: body.code,
        description: body.description ?? null,
        enabled: body.enabled ?? true,
        updated_by: principal.id,
        stdlib_version: STDLIB_VERSION,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await writeAudit({
      id: crypto.randomUUID(),
      ts: new Date(),
      tenant_id: principal.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
      action: "before_request_hook.changed",
      resource_type: "request_hook",
      resource_id: row.id,
      result: "success",
      trace_id: c.get("trace_id") ?? "",
      ip: null,
      user_agent: null,
      before: null,
      after: { role: row.role, version: row.version, enabled: row.enabled },
      reason: "created",
      metadata: {},
    });
    return c.json(serialize(row), 201);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await db
      .select()
      .from(requestHooks)
      .where(and(eq(requestHooks.tenant_id, principal.tenant_id), eq(requestHooks.id, id)));
    const cur = existing[0];
    if (!cur) throw new NotFoundError("request_hook");
    if (body.code !== undefined) {
      const lint = await lintHookSource(body.code);
      if (!lint.ok) {
        throw new BadRequestError("invalid hook source", { reason: lint.error });
      }
    }
    const updates: Partial<typeof requestHooks.$inferInsert> = {
      updated_at: new Date(),
      updated_by: principal.id,
    };
    if (body.code !== undefined) {
      updates.source = body.code;
      updates.version = cur.version + 1;
      updates.stdlib_version = STDLIB_VERSION;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    const [row] = await db
      .update(requestHooks)
      .set(updates)
      .where(and(eq(requestHooks.tenant_id, principal.tenant_id), eq(requestHooks.id, id)))
      .returning();
    if (!row) throw new NotFoundError("request_hook");
    await writeAudit({
      id: crypto.randomUUID(),
      ts: new Date(),
      tenant_id: principal.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
      action: "before_request_hook.changed",
      resource_type: "request_hook",
      resource_id: row.id,
      result: "success",
      trace_id: c.get("trace_id") ?? "",
      ip: null,
      user_agent: null,
      before: { version: cur.version, enabled: cur.enabled },
      after: { version: row.version, enabled: row.enabled },
      reason: "updated",
      metadata: {},
    });
    return c.json(serialize(row), 200);
  });

  app.openapi(deleteRouteSpec, async (c) => {
    const principal = requireAuth(c);
    requireAdmin(principal);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const [row] = await db
      .delete(requestHooks)
      .where(and(eq(requestHooks.tenant_id, principal.tenant_id), eq(requestHooks.id, id)))
      .returning();
    if (!row) throw new NotFoundError("request_hook");
    await writeAudit({
      id: crypto.randomUUID(),
      ts: new Date(),
      tenant_id: principal.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
      action: "before_request_hook.changed",
      resource_type: "request_hook",
      resource_id: row.id,
      result: "success",
      trace_id: c.get("trace_id") ?? "",
      ip: null,
      user_agent: null,
      before: { role: row.role, version: row.version },
      after: null,
      reason: "deleted",
      metadata: {},
    });
    return c.json({ deleted: true }, 200);
  });
}
