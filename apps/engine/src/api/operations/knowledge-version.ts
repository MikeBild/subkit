import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  KnowledgeVersionAlreadyCurrentError,
  KnowledgeVersionConflictError,
} from "../../knowledge/errors.ts";
import { KnowledgeSourceSchema } from "../../knowledge/types.ts";
import {
  getKnowledgeVersion,
  KNOWLEDGE_HISTORY_DEFAULT_LIMIT,
  KNOWLEDGE_HISTORY_MAX_LIMIT,
  listKnowledgeHistory,
  restoreKnowledgeVersion,
} from "../../knowledge/versions.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const TAGS = ["knowledge"] as const;

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

const HistoryQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(KNOWLEDGE_HISTORY_MAX_LIMIT)
    .optional()
    .describe(
      `Page size. Defaults to ${KNOWLEDGE_HISTORY_DEFAULT_LIMIT}, at most ${KNOWLEDGE_HISTORY_MAX_LIMIT}.`,
    ),
  offset: z.coerce.number().int().min(0).optional(),
});

interface HistoryInput {
  readonly id: string;
  readonly limit?: number;
  readonly offset?: number;
}

interface VersionInput {
  readonly id: string;
  readonly version: number;
}

type HistoryPage = NonNullable<Awaited<ReturnType<typeof listKnowledgeHistory>>>;
type VersionDetail = NonNullable<Awaited<ReturnType<typeof getKnowledgeVersion>>>;
type Restored = NonNullable<Awaited<ReturnType<typeof restoreKnowledgeVersion>>>;

function versionInput(param: unknown): VersionInput {
  const { id, version } = param as VersionInput;
  return { id, version };
}

export const listKnowledgeHistoryOperation = defineOperation<HistoryInput, HistoryPage>({
  id: "knowledge_source.history.list",
  summary: "List knowledge source versions, newest first",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, { id, limit, offset }) {
    const page = await listKnowledgeHistory(
      scope.tenant_id,
      id,
      {
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      },
      scope.db,
    );
    return page ?? reject.notFound("knowledge_source");
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/{id}/history",
    tags: TAGS,
    description:
      "One page of the source's content versions, newest first, each with its author and note. `current` marks the version agents and workflows read now. `total` is the size of the whole history: page with `limit` and `offset`.",
    params: IdParam,
    query: HistoryQuery,
    response: KnowledgeVersionListResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, query }) => {
      const { limit, offset } = query as { limit?: number; offset?: number };
      return {
        id: (param as { id: string }).id,
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      };
    },
    toBody: (page) => ({ items: page.rows, total: page.total }),
  },
});

export const getKnowledgeVersionOperation = defineOperation<VersionInput, VersionDetail>({
  id: "knowledge_source.history.get",
  summary: "Read one stored knowledge source version with its documents",
  permission: "knowledge:read",
  effect: "read",
  async handler(scope, { id, version }) {
    const detail = await getKnowledgeVersion(scope.tenant_id, id, version, scope.db);
    return detail ?? reject.notFound("knowledge_source_version");
  },
  http: {
    method: "get",
    path: "/v1/knowledge-sources/{id}/history/{version}",
    tags: TAGS,
    params: IdVersionParam,
    response: KnowledgeVersionDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => versionInput(param),
    toBody: (detail) => detail,
  },
});

export const restoreKnowledgeVersionOperation = defineOperation<VersionInput, Restored>({
  id: "knowledge_source.history.restore",
  summary: "Restore a previous knowledge source version as a new version",
  permission: "knowledge:write",
  effect: "write",
  audit: AuditAction.KNOWLEDGE_SOURCE_RESTORED,
  async handler(scope, { id, version }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const restored = await restoreKnowledgeVersion(
        scope.tenant_id,
        id,
        version,
        actorOf(principal),
        scope.db,
      );
      return restored ?? reject.notFound("knowledge_source_version");
    } catch (error) {
      if (error instanceof KnowledgeVersionAlreadyCurrentError) {
        return reject.conflict(error.message, { reason: error.code, version: error.version });
      }
      if (error instanceof KnowledgeVersionConflictError) {
        return reject.conflict(error.message, {
          expected_version: error.expected_version,
          current_version: error.current_version,
        });
      }
      throw error;
    }
  },
  http: {
    method: "post",
    path: "/v1/knowledge-sources/{id}/restore/{version}",
    tags: TAGS,
    description:
      "Reads the stored content of `version` in again. The result is always a new version whose note names the restored one; the history keeps every earlier version.",
    params: IdVersionParam,
    response: RestoreKnowledgeVersionResponse,
    errors: {
      404: "Not found",
      409: "The version is already current, or the source changed meanwhile",
    },
    toInput: ({ param }) => versionInput(param),
    toBody: (restored) => restored,
  },
});
