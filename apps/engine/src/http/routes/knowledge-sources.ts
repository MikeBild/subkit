import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CatalogGroupBySchema, CategoryFilterSchema } from "../../api/catalog-metadata.ts";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import * as svc from "../../knowledge/index.ts";
import {
  CreateKnowledgeSourceBundleSchema,
  CreateKnowledgeSourceInlineSchema,
  CreateKnowledgeSourceSchema,
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KnowledgeBudgetExceededError,
  KnowledgeSlugConflictError,
  KnowledgeSlugExistsError,
  KnowledgeSourceSchema,
  UpdateKnowledgeSourceSchema,
} from "../../knowledge/index.ts";
import { log } from "../../logging/index.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableEntityError,
} from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { registerKnowledgeDocumentRoutes } from "./knowledge-documents.ts";
import { registerKnowledgeVersionRoutes } from "./knowledge-versions.ts";

const KnowledgeSourceListResponse = z
  .object({
    items: z.array(KnowledgeSourceSchema),
    total: z.number().int().nonnegative(),
    sections_total: z.number().int().nonnegative(),
  })
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
        description_source: z.enum(["llm", "human"]).optional(),
        category: CategoryFilterSchema.optional(),
        q: z.string().min(1).max(200).optional(),
        sort: z.enum(["name", "status", "source_type", "bytes_total", "updated_at"]).optional(),
        group_by: CatalogGroupBySchema.optional(),
        order: z.enum(["asc", "desc"]).optional(),
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
    400: {
      description: "Invalid description acceptance",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "The reviewed description changed",
      content: { "application/json": { schema: ErrorSchema } },
    },
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

const KnowledgeSourceUploadError = z
  .object({ error: z.string(), hint: z.string().optional() })
  .openapi("KnowledgeSourceUploadError");

const KnowledgeSourceUploadForm = z
  .object({
    file: z.any().openapi({
      type: "string",
      format: "binary",
      description: "Document to ingest (markdown, text, JSON, ...)",
    }),
    metadata: z.string().optional().openapi({
      description: "JSON-encoded knowledge-source fields (name, scope, tags, ...)",
    }),
  })
  .openapi("KnowledgeSourceUploadForm");

const createUploadRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources",
  tags: ["knowledge"],
  summary: "Create a knowledge source from a multipart file upload",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { "multipart/form-data": { schema: KnowledgeSourceUploadForm } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    400: {
      description: "Missing file field or invalid metadata JSON",
      content: { "application/json": { schema: KnowledgeSourceUploadError } },
    },
    413: {
      description: "File exceeds maximum size",
      content: { "application/json": { schema: KnowledgeSourceUploadError } },
    },
  },
});

const KnowledgeBundleUpsertResponse = z
  .object({
    knowledge_source: KnowledgeSourceSchema,
    outcome: z.enum(["created", "updated", "unchanged"]),
    ingested_count: z.number().int(),
    skipped_count: z.number().int(),
    skipped_files: z.array(z.string()),
  })
  .openapi("KnowledgeBundleUpsertResponse");

const bundleRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/bundle",
  tags: ["knowledge"],
  summary: "Import a knowledge bundle (directory of markdown files, upsert by slug)",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateKnowledgeSourceBundleSchema } } },
  },
  responses: {
    200: {
      description: "Upserted (created, updated, or unchanged)",
      content: { "application/json": { schema: KnowledgeBundleUpsertResponse } },
    },
    409: {
      description: "Slug already belongs to a non-bundle knowledge source",
      content: { "application/json": { schema: ErrorSchema } },
    },
    413: {
      description: "Bundle exceeds maximum size",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const KnowledgeChunkListResponse = z
  .object({
    knowledge_source_id: z.string(),
    name: z.string(),
    chunk_count: z.number().int(),
    items: z.array(
      z.object({
        ordinal: z.number().int(),
        title: z.string().nullable(),
        path: z.string().nullable(),
        content: z.string(),
        byte_size: z.number().int(),
      }),
    ),
  })
  .openapi("KnowledgeChunkListResponse");

const chunksRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/{id}/chunks",
  tags: ["knowledge"],
  summary: "Read a knowledge source's full chunk content (paginated)",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z
      .object({
        path: z.string().optional().openapi({
          description:
            "Narrow to chunks with this bundle-relative path (e.g. /runbooks/deploy.md).",
        }),
        limit: z.coerce.number().int().positive().max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .openapi("ListKnowledgeChunksQuery"),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeChunkListResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const KnowledgeSourceContentResponse = z
  .object({
    knowledge_source_id: z.string().uuid(),
    version: z.string(),
    editable: z.boolean(),
    documents: z.array(z.object({ path: z.string(), content: z.string() })),
  })
  .openapi("KnowledgeSourceContentResponse");

const UpdateKnowledgeSourceContentBody = z
  .object({
    expected_version: z.string().min(1),
    path: z.string().min(1).max(512),
    content: z.string().min(1),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .openapi("UpdateKnowledgeSourceContentBody");

const contentRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/{id}/content",
  tags: ["knowledge"],
  summary: "Read editable Markdown content for a knowledge source",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeSourceContentResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const updateContentRoute = createRoute({
  method: "put",
  path: "/v1/knowledge-sources/{id}/content",
  tags: ["knowledge"],
  summary: "Replace one Markdown document using optimistic concurrency",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateKnowledgeSourceContentBody } } },
  },
  responses: {
    200: {
      description: "Updated",
      content: { "application/json": { schema: KnowledgeSourceContentResponse } },
    },
    400: {
      description: "Read-only source",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Version conflict",
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

const CreateKnowledgeSourceFromUrlBody = CreateKnowledgeSourceSchema.extend({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2048),
}).openapi("CreateKnowledgeSourceFromUrlBody");

const urlFailure = {
  413: {
    description: "The page exceeds the maximum size",
    content: { "application/json": { schema: ErrorSchema } },
  },
  422: {
    description: "The address could not be read, or is not allowed",
    content: { "application/json": { schema: ErrorSchema } },
  },
} as const;

const createFromUrlRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/url",
  tags: ["knowledge"],
  summary: "Create a knowledge source by reading an address",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CreateKnowledgeSourceFromUrlBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    ...urlFailure,
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/{id}/refresh",
  tags: ["knowledge"],
  summary: "Read an address source again now",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "Read again",
      content: { "application/json": { schema: KnowledgeSourceSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "The source has no address to read again or its address changed during refresh",
      content: { "application/json": { schema: ErrorSchema } },
    },
    ...urlFailure,
  },
});

function urlError(error: unknown): never {
  if (error instanceof svc.KnowledgeSourceAddressConflictError) {
    throw new ConflictError(error.message);
  }
  if (error instanceof svc.KnowledgeUrlFetchError)
    throw new UnprocessableEntityError(error.message, { reason: error.code });
  if (error instanceof KnowledgeBudgetExceededError)
    throw new PayloadTooLargeError(error.message, { bytes_limit: error.bytes_limit });
  if (error instanceof svc.KnowledgeSourceNotRefreshableError)
    throw new ConflictError(error.message, { reason: error.code, source_type: error.source_type });
  throw error;
}

export function registerKnowledgeSourceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/knowledge-sources", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("knowledge:read")(c, next);
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/url", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/:id/refresh", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/inline", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/bundle", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/:id/chunks", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("knowledge:read")(c, next);
    return next();
  });

  app.use("/v1/knowledge-sources/:id/content", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("knowledge:read")(c, next);
    if (c.req.method === "PUT") return requirePermission("knowledge:write")(c, next);
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

  registerKnowledgeVersionRoutes(app);
  registerKnowledgeDocumentRoutes(app);

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const params = {
      tenant_id: principal.tenant_id,
      ...(q.scope ? { scope: q.scope } : {}),
      ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.description_source ? { description_source: q.description_source } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.sort ? { sort: q.sort } : {}),
      ...(q.order ? { order: q.order } : {}),
      ...(q.group_by ? { group_by: q.group_by } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
    };
    const [items, totals] = await Promise.all([
      svc.listKnowledgeSources(params, db),
      svc.knowledgeSourceTotals(params, db),
    ]);
    return c.json({ items, ...totals }, 200);
  });

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

  app.openapi(chunksRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const result = await svc.listKnowledgeChunks(
      {
        tenant_id: principal.tenant_id,
        knowledge_source_id: id,
        ...(q.path !== undefined ? { path: q.path } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      db,
    );
    if (!result) throw new NotFoundError("knowledge_source");
    return c.json(
      {
        knowledge_source_id: result.source.id,
        name: result.source.name,
        chunk_count: result.source.chunk_count,
        items: result.chunks,
      },
      200,
    );
  });

  app.openapi(contentRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await svc.getKnowledgeSourceContent(principal.tenant_id, id, db);
    if (!result) throw new NotFoundError("knowledge_source");
    return c.json(result, 200);
  });

  app.openapi(updateContentRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const result = await svc.updateKnowledgeSourceContent(
        {
          tenant_id: principal.tenant_id,
          knowledge_source_id: id,
          expected_version: body.expected_version,
          path: body.path,
          content: body.content,
          ...(body.note !== undefined ? { note: body.note } : {}),
          actor: actorOf(principal),
        },
        db,
      );
      if (!result) throw new NotFoundError("knowledge_source");
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof svc.KnowledgeVersionConflictError) {
        throw new ConflictError(error.message, {
          expected_version: error.expected_version,
          current_version: error.current_version,
        });
      }
      if (error instanceof svc.KnowledgeContentReadOnlyError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
  });

  app.openapi(createFromUrlRoute, async (c) => {
    const principal = requireAuth(c);
    const { url, ...input } = c.req.valid("json");
    try {
      const source = await svc.createKnowledgeSourceFromUrl(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          url,
          input,
        },
        c.get("db"),
      );
      return c.json(source, 201);
    } catch (error) {
      return urlError(error);
    }
  });

  app.openapi(refreshRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    try {
      const source = await svc.refreshKnowledgeSource(
        {
          tenant_id: principal.tenant_id,
          actor: actorOf(principal),
          id,
        },
        c.get("db"),
      );
      if (!source) throw new NotFoundError("knowledge_source");
      return c.json(source, 200);
    } catch (error) {
      return urlError(error);
    }
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
    try {
      const updated = await svc.updateKnowledgeSource(
        {
          tenant_id: principal.tenant_id,
          id,
          patch: body,
          actor_id: principal.id,
          actor: actorOf(principal),
        },
        db,
      );
      if (!updated) throw new NotFoundError("knowledge_source");
      return c.json(updated, 200);
    } catch (error) {
      if (error instanceof svc.KnowledgeSourceAddressReadOnlyError) {
        throw new BadRequestError(error.message);
      }
      throw error;
    }
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
        actor: actorOf(principal),
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
    const deleted = await svc.deleteKnowledgeSource(
      principal.tenant_id,
      id,
      principal.id,
      db,
      actorOf(principal),
    );
    if (!deleted) throw new NotFoundError("knowledge_source");
    return c.json({ deleted: true }, 200);
  });

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
          actor: actorOf(principal),
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

  app.openapi(
    bundleRoute,
    async (c) => {
      const principal = requireAuth(c);
      const db = c.get("db");
      const body = c.req.valid("json");
      const { files, create_only, ...inputFields } = body;
      try {
        const result = await svc.upsertKnowledgeBundle(
          {
            tenant_id: principal.tenant_id,
            actor: actorOf(principal),
            input: inputFields,
            files,
            ...(create_only ? { create_only } : {}),
          },
          db,
        );
        return c.json(result, 200);
      } catch (err) {
        if (err instanceof KnowledgeSlugExistsError) {
          return c.json(
            {
              code: "slug_exists",
              message: err.message,
              details: { knowledge_source_id: err.knowledge_source_id },
            },
            409,
          );
        }
        if (err instanceof KnowledgeSlugConflictError) {
          return c.json(
            {
              code: "slug_conflict",
              message: err.message,
              hint: "bundle upserts only replace bundle sources; choose a different slug",
            },
            409,
          );
        }
        if (err instanceof KnowledgeBudgetExceededError) {
          return c.json(
            {
              code: "content_too_large",
              message: err.message,
              hint: "split the bundle into smaller sources or remove large files",
            },
            413,
          );
        }
        throw err;
      }
    },
    (result, c) => {
      if (result.success) return undefined;
      return c.json(
        {
          code: "validation_failed",
          message: "request body did not satisfy CreateKnowledgeSourceBundleBody",
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

  app.openapi(createUploadRoute, async (c) => {
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
        actor: actorOf(principal),
      },
      db,
    );

    if (source.description === null && source.tags.length === 0) {
      try {
        const enriched = await svc.analyzeKnowledgeSource(
          {
            tenant_id: principal.tenant_id,
            id: source.id,
            actor_id: principal.id,
            actor: actorOf(principal),
          },
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
