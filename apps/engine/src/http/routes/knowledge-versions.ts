import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import * as svc from "../../knowledge/index.ts";
import { KnowledgeSourceSchema } from "../../knowledge/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const KnowledgeVersionAuthorSchema = z
  .object({ kind: z.enum(["user", "system_account"]), id: z.string() })
  .nullable()
  .openapi("KnowledgeSourceVersionAuthor");

const KnowledgeVersionSchema = z
  .object({
    version: z.number().int().positive(),
    content_hash: z.string(),
    author: KnowledgeVersionAuthorSchema,
    note: z.string().nullable(),
    created_at: z.string(),
    current: z.boolean(),
  })
  .openapi("KnowledgeSourceVersion");

const KnowledgeVersionListResponse = z
  .object({ items: z.array(KnowledgeVersionSchema), total: z.number().int().nonnegative() })
  .openapi("KnowledgeSourceVersionListResponse");

const KnowledgeVersionDetailSchema = KnowledgeVersionSchema.extend({
  documents: z.array(z.object({ path: z.string(), content: z.string() })),
}).openapi("KnowledgeSourceVersionDetail");

const RestoreKnowledgeVersionResponse = z
  .object({ knowledge_source: KnowledgeSourceSchema, version: z.number().int().positive() })
  .openapi("RestoreKnowledgeSourceVersionResponse");

const IdVersionParam = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});

const notFound = {
  404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
} as const;

const historyRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/{id}/history",
  tags: ["knowledge"],
  summary: "List knowledge source versions, newest first",
  description:
    "One page of the source's content versions, newest first, each with its author and note. `current` marks the version agents and workflows read now. `total` is the size of the whole history: page with `limit` and `offset`.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    query: z.object({
      limit: z.coerce
        .number()
        .int()
        .positive()
        .max(svc.KNOWLEDGE_HISTORY_MAX_LIMIT)
        .optional()
        .describe(
          `Page size. Defaults to ${svc.KNOWLEDGE_HISTORY_DEFAULT_LIMIT}, at most ${svc.KNOWLEDGE_HISTORY_MAX_LIMIT}.`,
        ),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeVersionListResponse } },
    },
    ...notFound,
  },
});

const versionRoute = createRoute({
  method: "get",
  path: "/v1/knowledge-sources/{id}/history/{version}",
  tags: ["knowledge"],
  summary: "Read one stored knowledge source version with its documents",
  security: [{ bearerAuth: [] }],
  request: { params: IdVersionParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: KnowledgeVersionDetailSchema } },
    },
    ...notFound,
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/{id}/restore/{version}",
  tags: ["knowledge"],
  summary: "Restore a previous knowledge source version as a new version",
  description:
    "Reads the stored content of `version` in again. The result is always a new version whose note names the restored one; the history keeps every earlier version.",
  security: [{ bearerAuth: [] }],
  request: { params: IdVersionParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RestoreKnowledgeVersionResponse } },
    },
    ...notFound,
    409: {
      description: "The version is already current, or the source changed meanwhile",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerKnowledgeVersionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/knowledge-sources/:id/history", requirePermission("knowledge:read"));
  app.use("/v1/knowledge-sources/:id/history/:version", requirePermission("knowledge:read"));
  app.use("/v1/knowledge-sources/:id/restore/:version", requirePermission("knowledge:write"));

  app.openapi(historyRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const page = await svc.listKnowledgeHistory(
      principal.tenant_id,
      id,
      {
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      c.get("db"),
    );
    if (!page) throw new NotFoundError("knowledge_source");
    return c.json({ items: page.rows, total: page.total }, 200);
  });

  app.openapi(versionRoute, async (c) => {
    const principal = requireAuth(c);
    const { id, version } = c.req.valid("param");
    const detail = await svc.getKnowledgeVersion(principal.tenant_id, id, version, c.get("db"));
    if (!detail) throw new NotFoundError("knowledge_source_version");
    return c.json(detail, 200);
  });

  app.openapi(restoreRoute, async (c) => {
    const principal = requireAuth(c);
    const { id, version } = c.req.valid("param");
    try {
      const restored = await svc.restoreKnowledgeVersion(
        principal.tenant_id,
        id,
        version,
        actorOf(principal),
        c.get("db"),
      );
      if (!restored) throw new NotFoundError("knowledge_source_version");
      return c.json(restored, 200);
    } catch (error) {
      if (error instanceof svc.KnowledgeVersionAlreadyCurrentError) {
        throw new ConflictError(error.message, { reason: error.code, version: error.version });
      }
      if (error instanceof svc.KnowledgeVersionConflictError) {
        throw new ConflictError(error.message, {
          expected_version: error.expected_version,
          current_version: error.current_version,
        });
      }
      throw error;
    }
  });
}
