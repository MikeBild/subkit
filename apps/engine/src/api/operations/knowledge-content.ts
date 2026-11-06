import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { listKnowledgeChunks } from "../../knowledge/bundle-service.ts";
import {
  getKnowledgeSourceContent,
  updateKnowledgeSourceContent,
} from "../../knowledge/content.ts";
import {
  KnowledgeContentReadOnlyError,
  KnowledgeVersionConflictError,
} from "../../knowledge/errors.ts";
import { searchKnowledge } from "../../knowledge/service.ts";
import type {
  KnowledgeChunkView,
  KnowledgeSearchHit,
  KnowledgeSourceContent,
  KnowledgeSourceView,
  SearchKnowledgeParams,
} from "../../knowledge/types.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

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

const SearchKnowledgeQuery = z
  .object({
    q: z.string().min(1),
    scope: z.enum(["global", "workflow"]).optional(),
    workflow_id: z.string().uuid().optional(),
    tags: z.string().optional().openapi({
      description: "Comma-separated tags; narrows to sources carrying any of them.",
    }),
    limit: z.coerce.number().int().positive().max(50).optional(),
  })
  .openapi("SearchKnowledgeQuery");

type SearchQuery = z.infer<typeof SearchKnowledgeQuery>;
type SearchFilter = Omit<SearchKnowledgeParams, "tenant_id">;

function searchFilterFromQuery(q: SearchQuery): SearchFilter {
  return {
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
  };
}

export const searchKnowledgeOperation = defineOperation<SearchFilter, KnowledgeSearchHit[]>({
  id: "knowledge.search",
  summary: "Search across knowledge sources",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, filter) {
    return await searchKnowledge({ tenant_id: scope.tenant_id, ...filter }, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/search",
    tags: ["knowledge"],
    query: SearchKnowledgeQuery,
    response: SearchResultSchema,
    toInput: ({ query }) => searchFilterFromQuery(query as SearchQuery),
    toBody: (hits) => ({ hits }),
  },
});

const ListKnowledgeChunksQuery = z
  .object({
    path: z.string().optional().openapi({
      description: "Narrow to chunks with this bundle-relative path (e.g. /runbooks/deploy.md).",
    }),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListKnowledgeChunksQuery");

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

type ChunksQuery = z.infer<typeof ListKnowledgeChunksQuery>;

interface KnowledgeChunksInput extends ChunksQuery {
  readonly id: string;
}

interface KnowledgeChunkPage {
  readonly source: KnowledgeSourceView;
  readonly chunks: KnowledgeChunkView[];
}

export const listKnowledgeChunksOperation = defineOperation<
  KnowledgeChunksInput,
  KnowledgeChunkPage
>({
  id: "knowledge.chunks",
  summary: "Read a knowledge source's full chunk content (paginated)",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, { id, path, limit, offset }) {
    const result = await listKnowledgeChunks(
      {
        tenant_id: scope.tenant_id,
        knowledge_source_id: id,
        ...(path !== undefined ? { path } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      },
      scope.db,
    );
    return result ?? reject.notFound("knowledge_source");
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/{id}/chunks",
    tags: ["knowledge"],
    params: IdParam,
    query: ListKnowledgeChunksQuery,
    response: KnowledgeChunkListResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, query }) => ({
      ...(query as ChunksQuery),
      id: (param as { id: string }).id,
    }),
    toBody: (result) => ({
      knowledge_source_id: result.source.id,
      name: result.source.name,
      chunk_count: result.source.chunk_count,
      items: result.chunks,
    }),
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

type ContentBody = z.infer<typeof UpdateKnowledgeSourceContentBody>;

export const getKnowledgeSourceContentOperation = defineOperation<
  { id: string },
  KnowledgeSourceContent
>({
  id: "knowledge.content",
  summary: "Read editable Markdown content for a knowledge source",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, { id }) {
    return (
      (await getKnowledgeSourceContent(scope.tenant_id, id, scope.db)) ??
      reject.notFound("knowledge_source")
    );
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/{id}/content",
    tags: ["knowledge"],
    params: IdParam,
    response: KnowledgeSourceContentResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (content) => content,
  },
});

interface KnowledgeContentUpdateInput extends ContentBody {
  readonly id: string;
}

export const updateKnowledgeSourceContentOperation = defineOperation<
  KnowledgeContentUpdateInput,
  KnowledgeSourceContent
>({
  id: "knowledge.content_update",
  summary: "Replace one Markdown document using optimistic concurrency",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_INGESTED,
  async handler(scope, { id, expected_version, path, content, note }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const result = await updateKnowledgeSourceContent(
        {
          tenant_id: scope.tenant_id,
          knowledge_source_id: id,
          expected_version,
          path,
          content,
          ...(note !== undefined ? { note } : {}),
          actor: actorOf(principal),
        },
        scope.db,
      );
      return result ?? reject.notFound("knowledge_source");
    } catch (error) {
      if (error instanceof KnowledgeVersionConflictError) {
        return reject.conflict(error.message, {
          expected_version: error.expected_version,
          current_version: error.current_version,
        });
      }
      if (error instanceof KnowledgeContentReadOnlyError) return reject.badRequest(error.message);
      throw error;
    }
  },
  http: {
    method: "put",
    path: "/v1/knowledge-sources/{id}/content",
    tags: ["knowledge"],
    params: IdParam,
    body: UpdateKnowledgeSourceContentBody,
    response: KnowledgeSourceContentResponse,
    success: { status: 200, description: "Updated" },
    errors: { 400: "Read-only source", 404: "Not found", 409: "Version conflict" },
    toInput: ({ param, json }) => ({
      ...(json as ContentBody),
      id: (param as { id: string }).id,
    }),
    toBody: (content) => content,
  },
});
