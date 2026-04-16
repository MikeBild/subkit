// Knowledge Sources HTTP surface (programmatic / SDK access).
//
// The primary UX is conversational (file attachments in conversations).
// These endpoints exist for SDK consumers, CI/CD pipelines, and admin tools.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { KNOWLEDGE_SOURCE_MAX_BYTES } from "../../knowledge/budgets.ts";
import * as svc from "../../knowledge/service.ts";
import {
  CreateKnowledgeSourceSchema,
  KnowledgeSourceSchema,
  UpdateKnowledgeSourceSchema,
} from "../../knowledge/types.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { ErrorSchema } from "./identity/schemas.ts";

const IdParam = z.object({ id: z.string().uuid() });

const KnowledgeSourceListResponse = z
  .object({ items: z.array(KnowledgeSourceSchema) })
  .openapi("KnowledgeSourceListResponse");

const SearchResultSchema = z
  .object({
    hits: z.array(
      z.object({
        id: z.string(),
        knowledge_source_id: z.string(),
        title: z.string().nullable(),
        path: z.string().nullable(),
        snippet: z.string(),
        rank: z.number(),
      }),
    ),
  })
  .openapi("KnowledgeSearchResult");

const listRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources",
  tags: ["knowledge"],
  summary: "List knowledge sources",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        scope: z.enum(["global", "workflow"]).optional(),
        workflow_id: z.string().uuid().optional(),
        status: z.enum(["active", "inactive", "processing", "error"]).optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListKnowledgeSourcesQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeSourceListResponse } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/{id}",
  tags: ["knowledge"],
  summary: "Get a knowledge source",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/v1/knowledge-sources/{id}",
  tags: ["knowledge"],
  summary: "Update a knowledge source",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateKnowledgeSourceSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/v1/knowledge-sources/{id}",
  tags: ["knowledge"],
  summary: "Delete a knowledge source",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/search",
  tags: ["knowledge"],
  summary: "Search across knowledge sources",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        q: z.string().min(1),
        scope: z.enum(["global", "workflow"]).optional(),
        workflow_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
      })
      .openapi("SearchKnowledgeQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SearchResultSchema } },
    },
  },
});

export function registerKnowledgeSourceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/knowledge-sources", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("knowledge:read")(c, next);
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/:id", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("knowledge:read")(c, next);
    if (c.req.method === "PATCH") return requirePermission("knowledge:write")(c, next);
    if (c.req.method === "DELETE") return requirePermission("knowledge:delete")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/search", requirePermission("knowledge:read"));

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const items = await svc.listKnowledgeSources(
      {
        tenant_id: principal.tenant_id,
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    return c.json({ items }, 200);
  });

  // Search must be registered before :id to avoid path collision
  app.openapi(searchRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const hits = await svc.searchKnowledge(
      {
        tenant_id: principal.tenant_id,
        query: q.q,
        ...(q.scope ? { scope: q.scope } : {}),
        ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      },
      db,
    );
    return c.json({ hits }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const source = await svc.getKnowledgeSource(principal.tenant_id, id, db);
    if (!source) throw new NotFoundError("knowledge_source");
    return c.json(source, 200);
  });

  app.openapi(updateRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await svc.updateKnowledgeSource(
      { tenant_id: principal.tenant_id, id, patch: body, actor_id: principal.id },
      db,
    );
    if (!updated) throw new NotFoundError("knowledge_source");
    return c.json(updated, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await svc.deleteKnowledgeSource(principal.tenant_id, id, principal.id, db);
    if (!deleted) throw new NotFoundError("knowledge_source");
    return c.json({ deleted: true }, 200);
  });

  // Upload route (non-OpenAPI, multipart/form-data)
  app.post("/v1/knowledge-sources", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");

    const formData = await c.req.formData();
    const file = formData.get("file");
    const metadataRaw = formData.get("metadata");

    if (!(file instanceof File)) {
      return c.json({ error: "file field is required (multipart/form-data)" }, 400);
    }

    if (file.size > KNOWLEDGE_SOURCE_MAX_BYTES) {
      return c.json(
        { error: `File exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes` },
        413,
      );
    }

    let metadata: Record<string, unknown> = {};
    if (typeof metadataRaw === "string") {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        return c.json({ error: "metadata must be valid JSON" }, 400);
      }
    }

    const input = CreateKnowledgeSourceSchema.parse(metadata);
    const buffer = Buffer.from(await file.arrayBuffer());

    const source = await svc.createKnowledgeSource(
      {
        tenant_id: principal.tenant_id,
        input,
        upload: {
          buffer,
          filename: file.name,
          ...(file.type ? { mime: file.type } : {}),
        },
        actor_id: principal.id,
      },
      db,
    );

    return c.json(source, 201);
  });
}
