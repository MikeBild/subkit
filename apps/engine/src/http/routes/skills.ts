// Skills HTTP surface.
//
// Routes:
//   GET    /v1/skills                   — list (optional scope / status filters)
//   POST   /v1/skills                   — create
//   GET    /v1/skills/:id                — fetch
//   PATCH  /v1/skills/:id                — update
//   DELETE /v1/skills/:id                — hard delete (prefer /archive)
//   POST   /v1/skills/:id/activate       — flip lifecycle → active
//   POST   /v1/skills/:id/archive        — flip lifecycle → archived
//   GET    /v1/skills/:id/history        — version history (audit-derived)
//   POST   /v1/skills/:id/restore        — restore a prior audited snapshot
//
// Every mutation writes an audit entry via the service layer.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import {
  activateSkill,
  archiveSkill,
  CreateSkillSchema,
  createSkill,
  deleteSkill,
  getSkill,
  listSkillHistory,
  listSkills,
  restoreSkill,
  SkillLifecycleSchema,
  SkillSchema,
  SkillScopeSchema,
  UpdateSkillSchema,
  updateSkill,
} from "../../skills/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const SkillListResponse = paginatedResponse(SkillSchema, "SkillListResponse");

const ListQuery = z
  .object({
    scope: SkillScopeSchema.optional(),
    status: SkillLifecycleSchema.optional(),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListSkillsQuery");

const listRoute = createRoute({
  method: "get",
  path: "/v1/skills",
  tags: ["skills"],
  summary: "List skills",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillListResponse } } },
  },
});

const createRouteSpec = createRoute({
  method: "post",
  path: "/v1/skills",
  tags: ["skills"],
  summary: "Create a skill",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateSkillSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SkillSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRouteSpec = createRoute({
  method: "get",
  path: "/v1/skills/{id}",
  tags: ["skills"],
  summary: "Fetch a skill",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/v1/skills/{id}",
  tags: ["skills"],
  summary: "Update a skill",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateSkillSchema } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRouteSpec = createRoute({
  method: "delete",
  path: "/v1/skills/{id}",
  tags: ["skills"],
  summary: "Delete a skill (prefer archive)",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const activateRoute = createRoute({
  method: "post",
  path: "/v1/skills/{id}/activate",
  tags: ["skills"],
  summary: "Activate a skill",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const archiveRoute = createRoute({
  method: "post",
  path: "/v1/skills/{id}/archive",
  tags: ["skills"],
  summary: "Archive a skill",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const SkillHistoryEntrySchema = z
  .object({
    audit_entry_id: z.string().uuid(),
    version: z.number().int().nullable(),
    title: z.string().nullable(),
    lifecycle: z.string().nullable(),
    updated_at: z.string(),
    actor_id: z.string().uuid().nullable(),
    /** False for entries written before audit snapshots carried the full
     *  skill view — those entries are listed but not restorable. */
    has_snapshot: z.boolean(),
  })
  .openapi("SkillHistoryEntry");

const SkillHistoryResponse = z
  .object({ items: z.array(SkillHistoryEntrySchema) })
  .openapi("SkillHistoryResponse");

const RestoreSkillBody = z
  .object({ audit_entry_id: z.string().uuid() })
  .openapi("RestoreSkillBody");

const historyRoute = createRoute({
  method: "get",
  path: "/v1/skills/{id}/history",
  tags: ["skills"],
  summary: "List a skill's version history (audit-derived, newest first)",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SkillHistoryResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/v1/skills/{id}/restore",
  tags: ["skills"],
  summary: "Restore a skill to a prior audited snapshot",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RestoreSkillBody } } },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SkillSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSkillRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC gating for skills.
  app.use("/v1/skills", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("skill:read")(c, next);
    if (c.req.method === "POST") return requirePermission("skill:write")(c, next);
    return next();
  });
  app.use("/v1/skills/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("skill:read", () => ({ type: "skill", id }))(c, next);
    }
    if (c.req.method === "PATCH") {
      return requirePermission("skill:write", () => ({ type: "skill", id }))(c, next);
    }
    if (c.req.method === "DELETE") {
      return requirePermission("skill:delete", () => ({ type: "skill", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/skills/:id/activate", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("skill:activate", () => ({ type: "skill", id }))(c, next);
  });
  app.use("/v1/skills/:id/archive", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("skill:archive", () => ({ type: "skill", id }))(c, next);
  });
  app.use("/v1/skills/:id/history", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("skill:read", () => ({ type: "skill", id }))(c, next);
  });
  app.use("/v1/skills/:id/restore", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("skill:write", () => ({ type: "skill", id }))(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await listSkills(
      {
        tenant_id: principal.tenant_id,
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.connector_id ? { connector_id: q.connector_id } : {}),
        ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  app.openapi(createRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const created = await createSkill(
      { tenant_id: principal.tenant_id, input: body, actor_id: principal.id },
      db,
    );
    return c.json(created, 201);
  });

  app.openapi(getRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const s = await getSkill(principal.tenant_id, id, db);
    if (!s) throw new NotFoundError("skill");
    return c.json(s, 200);
  });

  app.openapi(patchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await updateSkill(principal.tenant_id, id, body, principal.id, db);
    if (!updated) throw new NotFoundError("skill");
    return c.json(updated, 200);
  });

  app.openapi(deleteRouteSpec, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await deleteSkill(principal.tenant_id, id, principal.id, db);
    if (!ok) throw new NotFoundError("skill");
    return c.body(null, 204);
  });

  app.openapi(activateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const s = await activateSkill(principal.tenant_id, id, principal.id, db);
    if (!s) throw new NotFoundError("skill");
    return c.json(s, 200);
  });

  app.openapi(archiveRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const s = await archiveSkill(principal.tenant_id, id, principal.id, db);
    if (!s) throw new NotFoundError("skill");
    return c.json(s, 200);
  });

  app.openapi(historyRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const skill = await getSkill(principal.tenant_id, id, db);
    if (!skill) throw new NotFoundError("skill");
    const items = await listSkillHistory(principal.tenant_id, id, db);
    return c.json({ items }, 200);
  });

  app.openapi(restoreRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { audit_entry_id } = c.req.valid("json");
    const restored = await restoreSkill(principal.tenant_id, id, audit_entry_id, principal.id, db);
    if (!restored) throw new NotFoundError("skill");
    return c.json(restored, 200);
  });
}
