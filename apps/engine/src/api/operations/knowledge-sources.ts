import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import { KnowledgeBudgetExceededError } from "../../knowledge/budgets.ts";
import {
  getKnowledgeSource,
  knowledgeSourceTotals,
  listKnowledgeSources,
} from "../../knowledge/catalog.ts";
import {
  KnowledgeSourceAddressConflictError,
  KnowledgeSourceAddressReadOnlyError,
} from "../../knowledge/errors.ts";
import {
  analyzeKnowledgeSource,
  deleteKnowledgeSource,
  updateKnowledgeSource,
} from "../../knowledge/service.ts";
import {
  CreateKnowledgeSourceSchema,
  KnowledgeSourceSchema,
  type KnowledgeSourceView,
  type ListKnowledgeSourcesParams,
  type UpdateKnowledgeSourceInput,
  UpdateKnowledgeSourceSchema,
} from "../../knowledge/types.ts";
import {
  createKnowledgeSourceFromUrl,
  KnowledgeSourceNotRefreshableError,
  KnowledgeUrlFetchError,
  refreshKnowledgeSource,
} from "../../knowledge/url-source.ts";
import { CatalogGroupBySchema, CategoryFilterSchema } from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, type Rejection, reject } from "./index.ts";

const ListKnowledgeSourcesQuery = z
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
  .openapi("ListKnowledgeSourcesQuery");

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

const DeleteKnowledgeSourceResponse = z.object({ deleted: z.boolean() });

type ListQuery = z.infer<typeof ListKnowledgeSourcesQuery>;
type ListFilter = Omit<ListKnowledgeSourcesParams, "tenant_id">;

interface KnowledgeSourceListResult {
  readonly items: KnowledgeSourceView[];
  readonly total: number;
  readonly sections_total: number;
}

function listFilterFromQuery(q: ListQuery): ListFilter {
  return {
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
}

export const listKnowledgeSourcesOperation = defineOperation<ListFilter, KnowledgeSourceListResult>(
  {
    id: "knowledge.list",
    summary: "List knowledge sources",
    permission: "knowledge:read",
    effect: "read",
    async handler(scope, filter) {
      const params = { tenant_id: scope.tenant_id, ...filter };
      const [items, totals] = await Promise.all([
        listKnowledgeSources(params, scope.db),
        knowledgeSourceTotals(params, scope.db),
      ]);
      return { items, ...totals };
    },
    http: {
      method: "get",
      path: "/v1/knowledge-sources",
      tags: ["knowledge"],
      query: ListKnowledgeSourcesQuery,
      response: KnowledgeSourceListResponse,
      toInput: ({ query }) => listFilterFromQuery(query as ListQuery),
      toBody: (result) => result,
    },
  },
);

export const getKnowledgeSourceOperation = defineOperation<{ id: string }, KnowledgeSourceView>({
  id: "knowledge.get",
  summary: "Get a knowledge source",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, { id }) {
    return (
      (await getKnowledgeSource(scope.tenant_id, id, scope.db)) ??
      reject.notFound("knowledge_source")
    );
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/{id}",
    tags: ["knowledge"],
    params: IdParam,
    response: KnowledgeSourceSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: (source) => source,
  },
});

interface KnowledgeSourcePatchInput {
  readonly id: string;
  readonly patch: UpdateKnowledgeSourceInput;
}

export const updateKnowledgeSourceOperation = defineOperation<
  KnowledgeSourcePatchInput,
  KnowledgeSourceView
>({
  id: "knowledge.update",
  summary: "Update a knowledge source",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_UPDATED,
  async handler(scope, { id, patch }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const updated = await updateKnowledgeSource(
        {
          tenant_id: scope.tenant_id,
          id,
          patch,
          actor_id: principal.id,
          actor: actorOf(principal),
        },
        scope.db,
      );
      return updated ?? reject.notFound("knowledge_source");
    } catch (error) {
      if (error instanceof KnowledgeSourceAddressReadOnlyError) {
        return reject.badRequest(error.message);
      }
      throw error;
    }
  },
  http: {
    method: "patch",
    path: "/v1/knowledge-sources/{id}",
    tags: ["knowledge"],
    params: IdParam,
    body: UpdateKnowledgeSourceSchema,
    response: KnowledgeSourceSchema,
    errors: {
      400: "Invalid description acceptance",
      404: "Not found",
      409: "The reviewed description changed",
    },
    toInput: ({ param, json }) => ({
      id: (param as { id: string }).id,
      patch: json as UpdateKnowledgeSourceInput,
    }),
    toBody: (source) => source,
  },
});

interface KnowledgeSourceAnalyzeInput {
  readonly id: string;
  readonly force?: boolean;
}

export const analyzeKnowledgeSourceOperation = defineOperation<
  KnowledgeSourceAnalyzeInput,
  KnowledgeSourceView
>({
  id: "knowledge.analyze",
  summary: "Analyze a knowledge source (LLM-generate description + tags)",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_ANALYZED,
  async handler(scope, { id, force }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const updated = await analyzeKnowledgeSource(
      {
        tenant_id: scope.tenant_id,
        id,
        actor_id: principal.id,
        actor: actorOf(principal),
        ...(force !== undefined ? { force } : {}),
      },
      scope.db,
    );
    return updated ?? reject.notFound("knowledge_source");
  },
  http: {
    method: "post",
    path: "/v1/knowledge-sources/{id}/analyze",
    tags: ["knowledge"],
    params: IdParam,
    body: AnalyzeKnowledgeSourceBody,
    response: AnalyzeKnowledgeSourceResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => {
      const { force } = json as z.infer<typeof AnalyzeKnowledgeSourceBody>;
      return { id: (param as { id: string }).id, ...(force !== undefined ? { force } : {}) };
    },
    toBody: (source) => ({ analyzed: true, knowledge_source: source }),
  },
});

export const deleteKnowledgeSourceOperation = defineOperation<{ id: string }, true>({
  id: "knowledge.delete",
  summary: "Delete a knowledge source",
  permission: "knowledge:delete",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_DELETED,
  async handler(scope, { id }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const deleted = await deleteKnowledgeSource(
      scope.tenant_id,
      id,
      principal.id,
      scope.db,
      actorOf(principal),
    );
    return deleted || reject.notFound("knowledge_source");
  },
  http: {
    method: "delete",
    path: "/v1/knowledge-sources/{id}",
    tags: ["knowledge"],
    params: IdParam,
    response: DeleteKnowledgeSourceResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => ({ id: (param as { id: string }).id }),
    toBody: () => ({ deleted: true }),
  },
});

const CreateKnowledgeSourceFromUrlBody = CreateKnowledgeSourceSchema.extend({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().max(2048),
}).openapi("CreateKnowledgeSourceFromUrlBody");

type FromUrlBody = z.infer<typeof CreateKnowledgeSourceFromUrlBody>;

const URL_FAILURES = {
  413: "The page exceeds the maximum size",
  422: "The address could not be read, or is not allowed",
} as const;

function urlRejection(error: unknown): Rejection {
  if (error instanceof KnowledgeSourceAddressConflictError) return reject.conflict(error.message);
  if (error instanceof KnowledgeUrlFetchError) {
    return {
      rejected: true,
      status: 422,
      code: "unprocessable_entity",
      message: error.message,
      details: { reason: error.code },
    };
  }
  if (error instanceof KnowledgeBudgetExceededError) {
    return {
      rejected: true,
      status: 413,
      code: "payload_too_large",
      message: error.message,
      details: { bytes_limit: error.bytes_limit },
    };
  }
  if (error instanceof KnowledgeSourceNotRefreshableError) {
    return reject.conflict(error.message, { reason: error.code, source_type: error.source_type });
  }
  throw error;
}

export const createKnowledgeSourceFromUrlOperation = defineOperation<
  FromUrlBody,
  KnowledgeSourceView
>({
  id: "knowledge.create_from_url",
  summary: "Create a knowledge source by reading an address",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_CREATED,
  async handler(scope, { url, ...input }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      return await createKnowledgeSourceFromUrl(
        { tenant_id: scope.tenant_id, actor: actorOf(principal), url, input },
        scope.db,
      );
    } catch (error) {
      return urlRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/knowledge-sources/url",
    tags: ["knowledge"],
    body: CreateKnowledgeSourceFromUrlBody,
    response: KnowledgeSourceSchema,
    success: { status: 201, description: "Created" },
    errors: URL_FAILURES,
    toInput: ({ json }) => json as FromUrlBody,
    toBody: (source) => source,
  },
});

export const refreshKnowledgeSourceOperation = defineOperation<{ id: string }, KnowledgeSourceView>(
  {
    id: "knowledge.refresh",
    summary: "Read an address source again now",
    permission: "knowledge:write",
    effect: "write",
    audit: AuditAction.KNOWLEDGE_SOURCE_INGESTED,
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      try {
        const source = await refreshKnowledgeSource(
          { tenant_id: scope.tenant_id, actor: actorOf(principal), id },
          scope.db,
        );
        return source ?? reject.notFound("knowledge_source");
      } catch (error) {
        return urlRejection(error);
      }
    },
    http: {
      method: "post",
      path: "/v1/knowledge-sources/{id}/refresh",
      tags: ["knowledge"],
      params: IdParam,
      response: KnowledgeSourceSchema,
      success: { status: 200, description: "Read again" },
      errors: {
        404: "Not found",
        409: "The source has no address to read again or its address changed during refresh",
        ...URL_FAILURES,
      },
      toInput: ({ param }) => ({ id: (param as { id: string }).id }),
      toBody: (source) => source,
    },
  },
);
