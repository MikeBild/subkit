import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../api/common-schemas.ts";
import { actorOf } from "../../audit/index.ts";
import * as svc from "../../knowledge/index.ts";
import { KnowledgeBudgetExceededError } from "../../knowledge/index.ts";
import {
  HttpError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableEntityError,
} from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const AppendKnowledgeSourceDocumentBody = z
  .object({
    expected_version: z.string().min(1),
    path: z.string().min(1).max(512),
    content: z.string().min(1),
  })
  .openapi("AppendKnowledgeSourceDocumentBody");

const AppendKnowledgeSourceDocumentResponse = z
  .object({
    knowledge_source_id: z.string().uuid(),
    version: z.string(),
    path: z.string(),
  })
  .openapi("AppendKnowledgeSourceDocumentResponse");

const appendDocumentRoute = createRoute({
  method: "post",
  path: "/v1/knowledge-sources/{id}/documents",
  tags: ["knowledge"],
  summary: "Append one Markdown document to a knowledge bundle using optimistic concurrency",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: AppendKnowledgeSourceDocumentBody } } },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: AppendKnowledgeSourceDocumentResponse } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
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

export function registerKnowledgeDocumentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/knowledge-sources/:id/documents", requirePermission("knowledge:write"));

  app.openapi(appendDocumentRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const result = await svc.appendKnowledgeSourceDocument(
        {
          tenant_id: principal.tenant_id,
          knowledge_source_id: id,
          expected_version: body.expected_version,
          path: body.path,
          content: body.content,
          actor: actorOf(principal),
        },
        db,
      );
      if (!result) throw new NotFoundError("knowledge_source");
      return c.json(
        {
          knowledge_source_id: result.knowledge_source_id,
          version: result.version,
          path: svc.normalizeBundlePath(body.path),
        },
        201,
      );
    } catch (error) {
      if (error instanceof svc.KnowledgeVersionConflictError) {
        throw new HttpError(409, "version_conflict", error.message, {
          details: {
            expected_version: error.expected_version,
            current_version: error.current_version,
          },
        });
      }
      if (error instanceof svc.KnowledgeDocumentPathExistsError) {
        throw new HttpError(409, "path_exists", error.message, { details: { path: error.path } });
      }
      if (error instanceof svc.KnowledgeBundleRequiredError) {
        throw new HttpError(409, "source_type_conflict", error.message, {
          details: { source_type: error.source_type },
        });
      }
      if (error instanceof svc.KnowledgeBundleDocumentLimitError) {
        throw new PayloadTooLargeError(error.message, { max_documents: error.max_documents });
      }
      if (error instanceof svc.KnowledgeDocumentPathInvalidError) {
        throw new UnprocessableEntityError(error.message);
      }
      if (error instanceof KnowledgeBudgetExceededError) {
        throw new PayloadTooLargeError(error.message, { bytes_limit: error.bytes_limit });
      }
      throw error;
    }
  });
}
