import { z } from "@hono/zod-openapi";
import { AuditAction } from "../../audit/types.ts";
import type { ToolResult } from "../../conversations/tools/index.ts";
import {
  activateSkill,
  archiveSkill,
  countSkills,
  createSkill,
  deleteSkill,
  getSkill,
  getSkillHistoryEntry,
  listSkillHistory,
  listSkills,
  restoreSkill,
  updateSkill,
} from "../../skills/service.ts";
import {
  type CreateSkillInput,
  CreateSkillSchema,
  type Skill,
  SkillLifecycleSchema,
  SkillSchema,
  SkillScopeSchema,
  type UpdateSkillInput,
  UpdateSkillSchema,
} from "../../skills/types.ts";
import { CatalogGroupBySchema, CategoryFilterSchema } from "../catalog-metadata.ts";
import { IdParam, paginatedResponse } from "../common-schemas.ts";
import { defineOperation, isRejection, type OperationScope, reject } from "./index.ts";

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

const SkillListResponse = paginatedResponse(SkillSchema, "SkillListResponse").extend({
  total: z.number().int().nonnegative(),
});

const ListSkillsQuery = z
  .object({
    scope: SkillScopeSchema.optional(),
    status: SkillLifecycleSchema.optional(),
    connector_id: z.string().uuid().optional(),
    workflow_id: z.string().uuid().optional(),
    description_source: z.enum(["llm", "human"]).optional(),
    category: CategoryFilterSchema.optional(),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["title", "scope", "status", "version", "updated_at"]).optional(),
    group_by: CatalogGroupBySchema.optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListSkillsQuery");

const ListAllSkillsToolInput = z
  .object({
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("ListAllSkillsToolInput");

const GetSkillToolInput = z.object({ id: z.string().uuid() }).openapi("GetSkillToolInput");

const UpdateSkillToolInput = z
  .object({ id: z.string().uuid() })
  .merge(UpdateSkillSchema)
  .openapi("UpdateSkillToolInput");

const DeleteSkillToolInput = z.object({ id: z.string().uuid() }).openapi("DeleteSkillToolInput");

const SkillHistoryEntrySchema = z
  .object({
    audit_entry_id: z.string().uuid(),
    version: z.number().int().nullable(),
    title: z.string().nullable(),
    lifecycle: z.string().nullable(),
    updated_at: z.string(),
    actor_id: z.string().uuid().nullable(),
    has_snapshot: z.boolean(),
  })
  .openapi("SkillHistoryEntry");

const SkillHistoryResponse = z
  .object({ items: z.array(SkillHistoryEntrySchema) })
  .openapi("SkillHistoryResponse");

const SkillHistoryStateSchema = z
  .object({ title: z.string(), body: z.string() })
  .nullable()
  .openapi("SkillHistoryState");

const SkillHistoryDetailSchema = SkillHistoryEntrySchema.extend({
  before: SkillHistoryStateSchema.describe(
    "Title and body before this change; null when the entry predates full snapshots.",
  ),
  after: SkillHistoryStateSchema.describe(
    "Title and body after this change; null when the entry predates full snapshots.",
  ),
}).openapi("SkillHistoryDetail");

const SkillHistoryEntryParam = z.object({
  id: z.string().uuid(),
  audit_entry_id: z.string().uuid(),
});

const RestoreSkillBody = z
  .object({ audit_entry_id: z.string().uuid() })
  .openapi("RestoreSkillBody");

type ListQuery = z.infer<typeof ListSkillsQuery>;
type ListToolArgs = z.infer<typeof ListAllSkillsToolInput>;
type SkillListInput = Omit<Parameters<typeof listSkills>[0], "tenant_id">;
type SkillHistoryItem = Awaited<ReturnType<typeof listSkillHistory>>[number];
type SkillHistoryDetail = NonNullable<Awaited<ReturnType<typeof getSkillHistoryEntry>>>;

interface SkillListResult {
  readonly items: Skill[];
  readonly total: number;
}

interface SkillIdInput {
  readonly id: string;
}

function idFrom(param: unknown): SkillIdInput {
  return { id: (param as SkillIdInput).id };
}

function listInputFromQuery(q: ListQuery): SkillListInput {
  return {
    ...(q.scope ? { scope: q.scope } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.connector_id ? { connector_id: q.connector_id } : {}),
    ...(q.workflow_id ? { workflow_id: q.workflow_id } : {}),
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

export const listSkillsOperation = defineOperation<SkillListInput, SkillListResult>({
  id: "skill.list",
  summary: "List skills",
  permission: "skill:read",
  effect: "read",
  async handler(scope, input) {
    const params = { tenant_id: scope.tenant_id, ...input };
    const [items, total] = await Promise.all([
      listSkills(params, scope.db),
      countSkills(params, scope.db),
    ]);
    return { items, total };
  },
  http: {
    method: "get",
    path: "/v1/skills",
    tags: ["skills"],
    query: ListSkillsQuery,
    response: SkillListResponse,
    toInput: ({ query }) => listInputFromQuery(query as ListQuery),
    toBody: ({ items, total }) => ({ items, total }),
  },
  tool: {
    name: "list_all_skills",
    description:
      "List every skill owned by the tenant, one page at a time (default 50, max 200, ordered by title) with `total`, `has_more` and `next_offset`; per item id, title, scope, updated_at. When `has_more` is true the list is incomplete: page through with `offset` before drawing conclusions. Different from `list_skills` which returns only skills applicable to the current conversation scope.",
    input: ListAllSkillsToolInput,
    gate: "enforced",
    toInput: (raw) => {
      const args = raw as ListToolArgs;
      return {
        sort: "title",
        order: "asc",
        limit: args.limit ?? LIST_DEFAULT_LIMIT,
        offset: args.offset ?? 0,
      };
    },
    toResult: (outcome, input) => {
      if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
      const limit = input.limit ?? LIST_DEFAULT_LIMIT;
      const offset = input.offset ?? 0;
      const hasMore = offset + outcome.items.length < outcome.total;
      return {
        ok: true,
        data: {
          total: outcome.total,
          limit,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + outcome.items.length } : {}),
          skills: outcome.items.map((s) => ({
            id: s.id,
            title: s.title,
            scope: s.scope,
            updated_at: s.updated_at,
          })),
        },
      };
    },
  },
});

export const createSkillOperation = defineOperation<CreateSkillInput, Skill>({
  id: "skill.create",
  summary: "Create a skill",
  permission: "skill:write",
  effect: "write",
  audit: AuditAction.SKILL_CREATED,
  async handler(scope, input) {
    const actor = scope.actor;
    return createSkill(
      {
        tenant_id: scope.tenant_id,
        input,
        actor_id: actor.id,
        actor_type: actor.type,
      },
      scope.db,
    );
  },
  http: {
    method: "post",
    path: "/v1/skills",
    tags: ["skills"],
    body: CreateSkillSchema,
    response: SkillSchema,
    success: { status: 201, description: "Created" },
    errors: { 400: "Bad request" },
    toInput: ({ json }) => json as CreateSkillInput,
    toBody: (skill) => skill,
  },
});

export const getSkillOperation = defineOperation<SkillIdInput, Skill>({
  id: "skill.get",
  summary: "Fetch a skill",
  permission: "skill:read",
  resource: { type: "skill", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    return (await getSkill(scope.tenant_id, id, scope.db)) ?? reject.notFound("skill");
  },
  http: {
    method: "get",
    path: "/v1/skills/{id}",
    tags: ["skills"],
    params: IdParam,
    response: SkillSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (skill) => skill,
  },
  tool: {
    name: "get_skill",
    description: "Fetch full skill body including examples, best_practices, pitfalls, doc_refs.",
    input: GetSkillToolInput,
    gate: "enforced",
    toInput: (raw) => idFrom(raw),
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: "skill_not_found" } };
      return { ok: true, data: { skill: outcome } };
    },
  },
});

interface SkillPatchInput {
  readonly id: string;
  readonly patch: UpdateSkillInput;
}

function skillNotFound(id: string): ToolResult {
  return { ok: false, data: { error: "not_found", message: `Skill ${id} not found` } };
}

function toolFailure(error: string, cause: unknown): ToolResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, data: { error, message } };
}

export const updateSkillOperation = defineOperation<SkillPatchInput, Skill>({
  id: "skill.update",
  summary: "Update a skill",
  permission: "skill:write",
  resource: { type: "skill", param: "id" },
  effect: "write",
  audit: AuditAction.SKILL_UPDATED,
  async handler(scope, { id, patch }) {
    const actor = scope.actor;
    const updated = await updateSkill(scope.tenant_id, id, patch, actor.id, scope.db, actor.type);
    return updated ?? reject.notFound("skill");
  },
  http: {
    method: "patch",
    path: "/v1/skills/{id}",
    tags: ["skills"],
    params: IdParam,
    body: UpdateSkillSchema,
    response: SkillSchema,
    errors: {
      400: "Invalid description acceptance",
      404: "Not found",
      409: "The reviewed description changed",
    },
    toInput: ({ param, json }) => ({ ...idFrom(param), patch: json as UpdateSkillInput }),
    toBody: (skill) => skill,
  },
  tool: {
    name: "update_skill",
    description:
      "Patch a persisted tenant Skill — edit its title/body, examples, best practices, pitfalls, doc refs, gated tools, activation rules, I/O schemas, side-effect/idempotency/maturity metadata, tags, or lifecycle status. Send only the fields that should change.",
    use_case:
      "Use when the user asks to rename a skill, revise its guidance, adjust when it activates, change which tools it gates, or change its lifecycle status. Send only the fields that should change.",
    important_notes: [
      "Send only the fields you want to change — omitted fields are left untouched.",
      "Audits as conversation.update_skill with full before/after snapshots.",
    ],
    input: UpdateSkillToolInput,
    gate: "enforced",
    toInput: (raw) => {
      const { id, ...patch } = raw as z.infer<typeof UpdateSkillToolInput>;
      return { id, patch };
    },
    prepare: (input, ctx) => ctx.engineClient.skills.get(input.id),
    toResult: async (outcome, { id, patch }, ctx, before) => {
      if (isRejection(outcome)) return skillNotFound(id);
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: id,
        action: "conversation.update_skill",
        result: "success",
        metadata: {
          conversation_id: ctx.conversation_id,
          fields: Object.keys(patch),
          before: before ?? null,
          after: outcome,
        },
      });
      return { ok: true, data: { updated: true, skill: outcome, audit_log_id } };
    },
    onError: (error) => toolFailure("update_failed", error),
  },
});

export const deleteSkillOperation = defineOperation<SkillIdInput, true>({
  id: "skill.delete",
  summary: "Delete a skill (prefer archive)",
  permission: "skill:delete",
  resource: { type: "skill", param: "id" },
  effect: "write",
  audit: AuditAction.SKILL_DELETED,
  async handler(scope, { id }) {
    const actor = scope.actor;
    const deleted = await deleteSkill(scope.tenant_id, id, actor.id, scope.db, actor.type);
    return deleted ? true : reject.notFound("skill");
  },
  http: {
    method: "delete",
    path: "/v1/skills/{id}",
    tags: ["skills"],
    params: IdParam,
    response: SkillSchema,
    success: { status: 204, description: "Deleted" },
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: () => null,
  },
  tool: {
    name: "delete_skill",
    description:
      "Hard-delete a skill by id — the row is permanently removed (prefer archiving instead). Requires confirmation first and records audit.",
    input: DeleteSkillToolInput,
    gate: "enforced",
    toInput: (raw) => idFrom(raw),
    toResult: async (outcome, { id }, ctx) => {
      if (isRejection(outcome)) return skillNotFound(id);
      const audit_log_id = await ctx.engineClient.audit_write({
        resource_type: "skill",
        resource_id: id,
        action: "conversation.delete_skill",
        result: "success",
        metadata: { conversation_id: ctx.conversation_id },
      });
      return { ok: true, data: { deleted: true, id, audit_log_id } };
    },
    onError: (error) => toolFailure("delete_failed", error),
  },
});

type LifecycleTransition = typeof activateSkill;

function lifecycleHandler(transition: LifecycleTransition) {
  return async (scope: OperationScope, { id }: SkillIdInput) => {
    const actor = scope.actor;
    const skill = await transition(scope.tenant_id, id, actor.id, scope.db, actor.type);
    return skill ?? reject.notFound("skill");
  };
}

export const activateSkillOperation = defineOperation<SkillIdInput, Skill>({
  id: "skill.activate",
  summary: "Activate a skill",
  permission: "skill:activate",
  resource: { type: "skill", param: "id" },
  effect: "write",
  audit: AuditAction.SKILL_ACTIVATED,
  handler: lifecycleHandler(activateSkill),
  http: {
    method: "post",
    path: "/v1/skills/{id}/activate",
    tags: ["skills"],
    params: IdParam,
    response: SkillSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (skill) => skill,
  },
});

export const archiveSkillOperation = defineOperation<SkillIdInput, Skill>({
  id: "skill.archive",
  summary: "Archive a skill",
  permission: "skill:archive",
  resource: { type: "skill", param: "id" },
  effect: "write",
  audit: AuditAction.SKILL_ARCHIVED,
  handler: lifecycleHandler(archiveSkill),
  http: {
    method: "post",
    path: "/v1/skills/{id}/archive",
    tags: ["skills"],
    params: IdParam,
    response: SkillSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (skill) => skill,
  },
});

export const listSkillHistoryOperation = defineOperation<SkillIdInput, SkillHistoryItem[]>({
  id: "skill.history",
  summary: "List a skill's version history (audit-derived, newest first)",
  permission: "skill:read",
  resource: { type: "skill", param: "id" },
  effect: "read",
  async handler(scope, { id }) {
    const skill = await getSkill(scope.tenant_id, id, scope.db);
    if (!skill) return reject.notFound("skill");
    return listSkillHistory(scope.tenant_id, id, scope.db);
  },
  http: {
    method: "get",
    path: "/v1/skills/{id}/history",
    tags: ["skills"],
    params: IdParam,
    response: SkillHistoryResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idFrom(param),
    toBody: (items) => ({ items }),
  },
});

interface SkillHistoryEntryInput {
  readonly id: string;
  readonly audit_entry_id: string;
}

export const getSkillHistoryEntryOperation = defineOperation<
  SkillHistoryEntryInput,
  SkillHistoryDetail
>({
  id: "skill.history_entry",
  summary: "Read one skill version with its title and body before and after the change",
  permission: "skill:read",
  resource: { type: "skill", param: "id" },
  effect: "read",
  async handler(scope, { id, audit_entry_id }) {
    const skill = await getSkill(scope.tenant_id, id, scope.db);
    if (!skill) return reject.notFound("skill");
    const entry = await getSkillHistoryEntry(scope.tenant_id, id, audit_entry_id, scope.db);
    return entry ?? reject.notFound("skill history entry");
  },
  http: {
    method: "get",
    path: "/v1/skills/{id}/history/{audit_entry_id}",
    tags: ["skills"],
    params: SkillHistoryEntryParam,
    response: SkillHistoryDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => {
      const { id, audit_entry_id } = param as SkillHistoryEntryInput;
      return { id, audit_entry_id };
    },
    toBody: (entry) => entry,
  },
});

export const restoreSkillOperation = defineOperation<SkillHistoryEntryInput, Skill>({
  id: "skill.restore",
  summary: "Restore a skill to a prior audited snapshot",
  permission: "skill:write",
  resource: { type: "skill", param: "id" },
  effect: "write",
  audit: AuditAction.SKILL_UPDATED,
  async handler(scope, { id, audit_entry_id }) {
    const actor = scope.actor;
    const restored = await restoreSkill(
      scope.tenant_id,
      id,
      audit_entry_id,
      actor.id,
      scope.db,
      actor.type,
    );
    return restored ?? reject.notFound("skill");
  },
  http: {
    method: "post",
    path: "/v1/skills/{id}/restore",
    tags: ["skills"],
    params: IdParam,
    body: RestoreSkillBody,
    response: SkillSchema,
    errors: { 404: "Not found", 409: "Conflict" },
    toInput: ({ param, json }) => ({
      ...idFrom(param),
      audit_entry_id: (json as { audit_entry_id: string }).audit_entry_id,
    }),
    toBody: (skill) => skill,
  },
});
