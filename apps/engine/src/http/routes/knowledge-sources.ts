// Knowledge Sources HTTP surface (programmatic / SDK access).
//
// The primary UX is conversational (file attachments in conversations).
// These endpoints exist for SDK consumers, CI/CD pipelines, and admin tools.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import * as svc from "../../knowledge/index.ts";
import {
  CreateKnowledgeSourceInlineSchema,
  CreateKnowledgeSourceSchema,
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KnowledgeSourceSchema,
  UpdateKnowledgeSourceSchema,
} from "../../knowledge/index.ts";
import { log } from "../../logging/index.ts";
import { NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const KnowledgeSourceListResponse = z
  .object({ items: z.array(KnowledgeSourceSchema) })
  .openapi("KnowledgeSourceListResponse");

const AnalyzeKnowledgeSourceBody = z
  .object({
    force: z.boolean().optional(),
  })
  .openapi("AnalyzeKnowledgeSourceBody");

const AnalyzeKnowledgeSourceResponse = z
  .object({
    analyzed: z.boolean(),
    knowledge_source: KnowledgeSourceSchema,
  })
  .openapi("AnalyzeKnowledgeSourceResponse");

const SearchResultSchema = z
  .object({
    hits: z.array(
      z.object({
        id: z.string(),
        knowledge_source_id: z.string(),
        source_name: z.string(),
        source_tags: z.array(z.string()),
        title: z.string().nullable(),
        path: z.string().nullable(),
        snippet: z.string(),
        rank: z.number(),
        fetched_at: z.string().nullable(),
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
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ deleted: z.boolean() }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const analyzeRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/{id}/analyze",
  tags: ["knowledge"],
  summary: "Analyze a knowledge source (LLM-generate description + tags)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AnalyzeKnowledgeSourceBody } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: AnalyzeKnowledgeSourceResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// Web-scraper — JSON inline ingestion. The legacy
// POST /v1/knowledge-sources stays on multipart/form-data (file
// uploads); recipes that produce extracted markdown POST to this
// route instead so the OpenAPI surface advertises the JSON contract
// and Zod validates the body before the handler runs.
const createInlineRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/inline",
  tags: ["knowledge"],
  summary: "Create a knowledge source from inline JSON content",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateKnowledgeSourceInlineSchema } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    413: {
      description: "Content exceeds maximum size",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorSchema } },
    },
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
        tags: z.string().optional().openapi({
          description: "Comma-separated tags; narrows to sources carrying any of them.",
        }),
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

  app.use("/v1/knowledge-sources/inline", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/:id/analyze", async (c, next) => {
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
        ...(q.tags
          ? {
              tags: q.tags
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0),
            }
          : {}),
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

  app.openapi(analyzeRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await svc.analyzeKnowledgeSource(
      {
        tenant_id: principal.tenant_id,
        id,
        actor_id: principal.id,
        ...(body.force !== undefined ? { force: body.force } : {}),
      },
      db,
    );
    if (!updated) throw new NotFoundError("knowledge_source");
    return c.json({ analyzed: true, knowledge_source: updated }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const deleted = await svc.deleteKnowledgeSource(principal.tenant_id, id, principal.id, db);
    if (!deleted) throw new NotFoundError("knowledge_source");
    return c.json({ deleted: true }, 200);
  });

  // JSON inline path — separate OpenAPI route so Zod validates
  // the body up-front and the spec advertises the JSON contract.
  // 422 is the documented validation-failure status on `createInlineRoute`.
  // Without this `defaultHook`, Hono's zod-openapi returns 400 on Zod
  // failure, drifting from the OpenAPI spec and forcing clients to
  // branch on both codes. The hook normalises to 422 + a typed error
  // envelope that matches `ErrorSchema`.
  app.openapi(
    createInlineRoute,
    async (c) => {
      const principal = requireAuth(c);
      const db = c.get("db");
      const body = c.req.valid("json");
      const byteSize = Buffer.byteLength(body.content, "utf8");
      if (byteSize > KNOWLEDGE_SOURCE_MAX_BYTES) {
        return c.json(
          {
            code: "content_too_large",
            message: `Content exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
            hint: `content is ${byteSize} bytes, limit is ${KNOWLEDGE_SOURCE_MAX_BYTES} — split the document into smaller sources`,
          },
          413,
        );
      }
      const { content, mime_type, source_uri, ...inputFields } = body;
      const filename = source_uri ?? `${inputFields.slug ?? inputFields.name}.md`;
      const source = await svc.createKnowledgeSource(
        {
          tenant_id: principal.tenant_id,
          input: inputFields,
          upload: {
            buffer: Buffer.from(content, "utf8"),
            filename,
            mime: mime_type,
          },
          actor_id: principal.id,
          source_type_override: "inline",
          source_uri_override: source_uri ?? filename,
        },
        db,
      );
      return c.json(source, 201);
    },
    (result, c) => {
      if (result.success) return undefined;
      return c.json(
        {
          code: "validation_failed",
          message: "request body did not satisfy CreateKnowledgeSourceInlineBody",
          details: {
            issues: result.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
        },
        422,
      );
    },
  );

  // Legacy multipart upload route (non-OpenAPI). File uploads only.
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
        {
          error: `File exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
          hint: `file is ${file.size} bytes, limit is ${KNOWLEDGE_SOURCE_MAX_BYTES} — split the document into smaller sources`,
        },
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

    let source = await svc.createKnowledgeSource(
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

    // Interactive auto-enrich (best-effort): generate a description + tags
    // ONLY when the upload landed with neither. Supplying explicit tags (or a
    // description) opts out entirely — auto-analysis would otherwise overwrite
    // the operator's authoritative tags, contradicting the `--tags` contract
    // ("omit to auto-generate"). Runs after the create commits, outside its
    // transaction. Any failure (incl. LlmQuotaExhausted) leaves the source
    // created/un-enriched and never fails the upload.
    if (source.description === null && source.tags.length === 0) {
      try {
        const enriched = await svc.analyzeKnowledgeSource(
          { tenant_id: principal.tenant_id, id: source.id, actor_id: principal.id },
          db,
        );
        if (enriched) source = enriched;
      } catch (err) {
        log.knowledge.analyze_skipped({
          knowledge_source_id: source.id,
          tenant_id: principal.tenant_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return c.json(source, 201);
  });
}
