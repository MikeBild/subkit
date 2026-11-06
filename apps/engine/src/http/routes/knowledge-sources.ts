import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getKnowledgeSourceContentOperation,
  listKnowledgeChunksOperation,
  searchKnowledgeOperation,
  updateKnowledgeSourceContentOperation,
} from "../../api/operations/knowledge-content.ts";
import {
  createKnowledgeSourceInlineOperation,
  upsertKnowledgeBundleOperation,
} from "../../api/operations/knowledge-ingest.ts";
import {
  analyzeKnowledgeSourceOperation,
  createKnowledgeSourceFromUrlOperation,
  deleteKnowledgeSourceOperation,
  getKnowledgeSourceOperation,
  listKnowledgeSourcesOperation,
  refreshKnowledgeSourceOperation,
  updateKnowledgeSourceOperation,
} from "../../api/operations/knowledge-sources.ts";
import { actorOf } from "../../audit/index.ts";
import * as svc from "../../knowledge/index.ts";
import {
  CreateKnowledgeSourceSchema,
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KnowledgeSourceSchema,
} from "../../knowledge/index.ts";
import { log } from "../../logging/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";
import { registerKnowledgeDocumentRoutes } from "./knowledge-documents.ts";
import { registerKnowledgeVersionRoutes } from "./knowledge-versions.ts";

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
    409: {
      description: "A knowledge source with this slug already exists",
      content: { "application/json": { schema: ErrorSchema } },
    },
    413: {
      description: "File exceeds maximum size",
      content: { "application/json": { schema: KnowledgeSourceUploadError } },
    },
  },
});

export function registerKnowledgeSourceRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/knowledge-sources", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("knowledge:write")(c, next);
    return next();
  });

  registerKnowledgeVersionRoutes(app);
  registerKnowledgeDocumentRoutes(app);

  toHonoRoute(app, listKnowledgeSourcesOperation);

  toHonoRoute(app, searchKnowledgeOperation);

  toHonoRoute(app, listKnowledgeChunksOperation);

  toHonoRoute(app, getKnowledgeSourceContentOperation);

  toHonoRoute(app, updateKnowledgeSourceContentOperation);

  toHonoRoute(app, createKnowledgeSourceFromUrlOperation);

  toHonoRoute(app, refreshKnowledgeSourceOperation);

  toHonoRoute(app, getKnowledgeSourceOperation);

  toHonoRoute(app, updateKnowledgeSourceOperation);

  toHonoRoute(app, analyzeKnowledgeSourceOperation);

  toHonoRoute(app, deleteKnowledgeSourceOperation);

  toHonoRoute(app, createKnowledgeSourceInlineOperation);

  toHonoRoute(app, upsertKnowledgeBundleOperation);

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
