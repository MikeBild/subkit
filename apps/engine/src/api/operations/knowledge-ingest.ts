import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KnowledgeBudgetExceededError,
} from "../../knowledge/budgets.ts";
import {
  KnowledgeSlugConflictError,
  KnowledgeSlugExistsError,
  upsertKnowledgeBundle,
} from "../../knowledge/bundle-service.ts";
import { createKnowledgeSource } from "../../knowledge/service.ts";
import {
  CreateKnowledgeSourceBundleSchema,
  CreateKnowledgeSourceInlineSchema,
  type KnowledgeBundleUpsertResult,
  KnowledgeSourceSchema,
  type KnowledgeSourceView,
} from "../../knowledge/types.ts";
import {
  defineOperation,
  plainRejection,
  type Rejection,
  reject,
  type ValidationIssue,
} from "./index.ts";

type InlineBody = z.infer<typeof CreateKnowledgeSourceInlineSchema>;
type BundleBody = z.infer<typeof CreateKnowledgeSourceBundleSchema>;

function validationFailed(schemaName: string, issues: readonly ValidationIssue[]): Rejection {
  return plainRejection(422, "validation_failed", `request body did not satisfy ${schemaName}`, {
    details: { issues },
  });
}

export const createKnowledgeSourceInlineOperation = defineOperation<
  InlineBody,
  KnowledgeSourceView
>({
  id: "knowledge.create_inline",
  summary: "Create a knowledge source from inline JSON content",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_CREATED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const byteSize = Buffer.byteLength(body.content, "utf8");
    if (byteSize > KNOWLEDGE_SOURCE_MAX_BYTES) {
      return plainRejection(
        413,
        "content_too_large",
        `Content exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
        {
          hint: `content is ${byteSize} bytes, limit is ${KNOWLEDGE_SOURCE_MAX_BYTES} — split the document into smaller sources`,
        },
      );
    }
    const { content, mime_type, source_uri, ...inputFields } = body;
    const filename = source_uri ?? `${inputFields.slug ?? inputFields.name}.md`;
    return await createKnowledgeSource(
      {
        tenant_id: scope.tenant_id,
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
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/knowledge-sources/inline",
    tags: ["knowledge"],
    body: CreateKnowledgeSourceInlineSchema,
    response: KnowledgeSourceSchema,
    success: { status: 201, description: "Created" },
    errors: {
      409: "A knowledge source with this slug already exists",
      413: "Content exceeds maximum size",
      422: "Validation error",
    },
    invalid: (issues) => validationFailed("CreateKnowledgeSourceInlineBody", issues),
    toInput: ({ json }) => json as InlineBody,
    toBody: (source) => source,
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

function bundleRejection(error: unknown): Rejection {
  if (error instanceof KnowledgeSlugExistsError) {
    return plainRejection(409, "slug_exists", error.message, {
      details: { knowledge_source_id: error.knowledge_source_id },
    });
  }
  if (error instanceof KnowledgeSlugConflictError) {
    return plainRejection(409, "slug_conflict", error.message, {
      hint: "bundle upserts only replace bundle sources; choose a different slug",
    });
  }
  if (error instanceof KnowledgeBudgetExceededError) {
    return plainRejection(413, "content_too_large", error.message, {
      hint: "split the bundle into smaller sources or remove large files",
    });
  }
  throw error;
}

export const upsertKnowledgeBundleOperation = defineOperation<
  BundleBody,
  KnowledgeBundleUpsertResult
>({
  id: "knowledge.bundle",
  summary: "Import a knowledge bundle (directory of markdown files, upsert by slug)",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_INGESTED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const { files, create_only, ...inputFields } = body;
    try {
      return await upsertKnowledgeBundle(
        {
          tenant_id: scope.tenant_id,
          actor: actorOf(principal),
          input: inputFields,
          files,
          ...(create_only ? { create_only } : {}),
        },
        scope.db,
      );
    } catch (error) {
      return bundleRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/knowledge-sources/bundle",
    tags: ["knowledge"],
    body: CreateKnowledgeSourceBundleSchema,
    response: KnowledgeBundleUpsertResponse,
    success: { status: 200, description: "Upserted (created, updated, or unchanged)" },
    errors: {
      409: "Slug already belongs to a non-bundle knowledge source",
      413: "Bundle exceeds maximum size",
      422: "Validation error",
    },
    invalid: (issues) => validationFailed("CreateKnowledgeSourceBundleBody", issues),
    toInput: ({ json }) => json as BundleBody,
    toBody: (result) => result,
  },
});
