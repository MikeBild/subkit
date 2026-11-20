import { z } from "@hono/zod-openapi";
import { actorType } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { taskRunListReader } from "../../conversations/public/lifecycle.ts";
import type {
  ConversationDetail,
  ConversationRecord,
  ConversationStatus,
} from "../../conversations/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationLocale } from "../../http/routes/conversations/locale.ts";
import {
  CONFIRM_PROMPT_KINDS,
  type ConfirmPromptKind,
  ConversationDetailSchema,
  ConversationListResponse,
  ConversationSchema,
  PatchConversationBody,
} from "../../http/routes/conversations/schemas.ts";
import { IdParam } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const ListConversationsQuery = z
  .object({
    status: z.enum(["active", "awaiting_input", "committed", "abandoned"]).optional(),
    owner: z.literal("me").optional(),
    hidden: z.enum(["exclude", "only", "all"]).optional(),
    task_runs: z
      .enum(["exclude", "only", "all"])
      .optional()
      .describe(
        "Conversations that belong to a task run. They are left out by default; `only` lists just them, `all` lists both.",
      ),
    owner_kind: z.enum(["user", "system_account"]).optional(),
    target_workflow_id: z.string().uuid().optional(),
    target_connector_id: z.string().uuid().optional(),
    referenced_skill_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Only conversations that mention this skill with an @ reference or loaded it with load_skill. Requires skill:read on the skill.",
      ),
    referenced_knowledge_source_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Only conversations that mention this knowledge source with an @ reference or read, fetched or found it through a knowledge tool. Requires knowledge:read.",
      ),
    q: z.string().min(1).max(200).optional(),
    sort: z.enum(["title", "status", "created_at", "updated_at"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListConversationsQuery");

type ListQuery = z.infer<typeof ListConversationsQuery>;
type PatchBody = z.infer<typeof PatchConversationBody>;

interface IdInput {
  readonly id: string;
}

interface PatchInput extends IdInput {
  readonly body: PatchBody;
}

interface ListParams {
  tenant_id: string;
  status?: ConversationStatus;
  owner_id?: string;
  viewer_user_id?: string;
  hidden?: "exclude" | "only" | "all";
  task_runs?: "exclude" | "only" | "all";
  task_run_reader?: string;
  owner_kind?: "user" | "system_account";
  target_workflow_id?: string;
  target_connector_id?: string;
  referenced_skill_id?: string;
  referenced_knowledge_source_id?: string;
  q?: string;
  sort?: "title" | "status" | "created_at" | "updated_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ConfirmPromptDiff {
  label: string;
  preview?: string;
}

export interface ConversationCollectionServices {
  listConversations(p: ListParams, exec: Db): Promise<object[]>;
  countConversations(p: ListParams, exec: Db): Promise<number>;
  getConversation(
    tenant_id: string,
    id: string,
    exec: Db,
    principal?: ResolvedPrincipal,
    locale?: "de" | "en",
  ): Promise<ConversationDetail | null>;
  buildMessages(
    messages: ConversationDetail["messages"],
    toolCalls: ConversationDetail["tool_calls"],
  ): object[];
  readConversationUsage(db: Db, tenantId: string, conversationId: string): Promise<object>;
  isConversationHiddenFor(
    p: { tenant_id: string; conversation_id: string; user_id: string },
    exec: Db,
  ): Promise<boolean>;
  patchConversation(
    p: {
      tenant_id: string;
      conversation_id: string;
      actor_id: string | null;
      actor_type?: "user" | "system_account" | "system" | "unknown";
      model?: string | null;
      title?: string | null;
    },
    exec: Db,
  ): Promise<ConversationRecord | null>;
}

function isConfirmKind(value: unknown): value is ConfirmPromptKind {
  return typeof value === "string" && (CONFIRM_PROMPT_KINDS as readonly string[]).includes(value);
}

function confirmDiff(value: unknown): ConfirmPromptDiff[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const { label, preview } = value as Record<string, unknown>;
  if (typeof label !== "string") return [];
  return [{ label, ...(typeof preview === "string" ? { preview } : {}) }];
}

export function confirmPromptFields(input: unknown): {
  kind?: ConfirmPromptKind;
  diffs?: ConfirmPromptDiff[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const { kind, diffs } = input as Record<string, unknown>;
  const parsed = Array.isArray(diffs) ? diffs.flatMap(confirmDiff) : [];
  const confirmKind = kind === undefined ? "generic" : isConfirmKind(kind) ? kind : undefined;
  return {
    ...(confirmKind ? { kind: confirmKind } : {}),
    ...(parsed.length > 0 ? { diffs: parsed } : {}),
  };
}

function withConfirmPrompt(detail: ConversationDetail): ConversationDetail {
  const summary = detail.resume_summary;
  const pending = summary?.pending_approval;
  if (!summary || !pending?.prompt || pending.tool_name !== "ask_user_confirm") return detail;
  const prompt: typeof pending.prompt & { kind?: unknown; diffs?: unknown } = pending.prompt;
  if (prompt.kind !== undefined && prompt.diffs !== undefined) return detail;
  const call = detail.tool_calls.find(
    (candidate) => candidate.id === pending.tool_call_id && candidate.tool === "ask_user_confirm",
  );
  if (!call) return detail;
  const stored = confirmPromptFields(call.input);
  return {
    ...detail,
    resume_summary: {
      ...summary,
      pending_approval: {
        ...pending,
        prompt: {
          ...prompt,
          ...(prompt.kind === undefined && stored.kind ? { kind: stored.kind } : {}),
          ...(prompt.diffs === undefined && stored.diffs ? { diffs: stored.diffs } : {}),
        },
      },
    },
  };
}

function listParams(principal: ResolvedPrincipal, q: ListQuery): ListParams {
  const reader = taskRunListReader(principal);
  return {
    tenant_id: principal.tenant_id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.owner === "me" ? { owner_id: principal.id } : {}),
    ...(principal.kind === "user" ? { viewer_user_id: principal.id } : {}),
    ...(q.hidden ? { hidden: q.hidden } : {}),
    ...(q.task_runs ? { task_runs: q.task_runs } : {}),
    ...(reader ? { task_run_reader: reader } : {}),
    ...(q.owner_kind ? { owner_kind: q.owner_kind } : {}),
    ...(q.target_workflow_id ? { target_workflow_id: q.target_workflow_id } : {}),
    ...(q.target_connector_id ? { target_connector_id: q.target_connector_id } : {}),
    ...(q.referenced_skill_id ? { referenced_skill_id: q.referenced_skill_id } : {}),
    ...(q.referenced_knowledge_source_id
      ? { referenced_knowledge_source_id: q.referenced_knowledge_source_id }
      : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.sort ? { sort: q.sort } : {}),
    ...(q.order ? { order: q.order } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.offset !== undefined ? { offset: q.offset } : {}),
  };
}

function same<T>(result: T): T {
  return result;
}

export function conversationCollectionOperations(svc: ConversationCollectionServices) {
  const list = defineOperation<ListQuery, { items: object[]; total: number }>({
    id: "conversation.list",
    summary: "List conversations",
    permission: "conversation:list",
    alternatePermissions: ["workflow:read"],
    effect: "read",
    async handler(scope, q) {
      const principal = scope.principal;
      const ensurePermission = scope.ensurePermission;
      if (!principal || !ensurePermission) return reject.unauthorized();
      if (q.referenced_skill_id) {
        await ensurePermission("skill:read", { type: "skill", id: q.referenced_skill_id });
      }
      if (q.referenced_knowledge_source_id) {
        await ensurePermission("knowledge:read", {
          type: "knowledge",
          id: q.referenced_knowledge_source_id,
        });
      }
      const params = listParams(principal, q);
      const [items, total] = await Promise.all([
        svc.listConversations(params, scope.db),
        svc.countConversations(params, scope.db),
      ]);
      return { items, total };
    },
    http: {
      method: "get",
      path: "/v1/conversations",
      tags: ["conversations"],
      query: ListConversationsQuery,
      response: ConversationListResponse,
      toInput: ({ query }) => query as ListQuery,
      toBody: same,
    },
  });

  const detail = defineOperation<IdInput, object>({
    id: "conversation.get",
    summary: "Fetch a conversation with messages, tool calls, and draft",
    permission: "conversation:read",
    alternatePermissions: ["workflow:read"],
    effect: "read",
    async handler(scope, { id }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const headers = scope.request?.headers;
      const loaded = await svc.getConversation(
        scope.tenant_id,
        id,
        scope.db,
        principal,
        conversationLocale(
          headers?.get("cookie") ?? undefined,
          headers?.get("accept-language") ?? undefined,
        ),
      );
      if (!loaded) return reject.notFound("conversation");
      const found = withConfirmPrompt(loaded);
      const messages = svc.buildMessages(found.messages, found.tool_calls);
      const usage = await svc.readConversationUsage(scope.db, scope.tenant_id, id);
      const hidden =
        principal.kind === "user"
          ? await svc.isConversationHiddenFor(
              { tenant_id: scope.tenant_id, conversation_id: id, user_id: principal.id },
              scope.db,
            )
          : false;
      return {
        conversation: { ...found.conversation, hidden },
        owner: found.owner,
        created_resources: found.created_resources,
        messages,
        tool_calls: found.tool_calls,
        draft: found.draft,
        playbook: found.playbook ?? null,
        ...(found.resume_summary ? { resume_summary: found.resume_summary } : {}),
        usage,
      };
    },
    http: {
      method: "get",
      path: "/v1/conversations/{id}",
      tags: ["conversations"],
      params: IdParam,
      response: ConversationDetailSchema,
      errors: { 404: "Not found" },
      toInput: ({ param }) => ({ id: (param as IdInput).id }),
      toBody: same,
    },
  });

  const patch = defineOperation<PatchInput, ConversationRecord>({
    id: "conversation.patch",
    summary: "Patch conversation metadata (model, title)",
    permission: "conversation:write",
    alternatePermissions: ["workflow:write"],
    effect: "write",
    audit: AuditAction.CONVERSATION_UPDATED,
    async handler(scope, { id, body }) {
      const principal = scope.principal;
      if (!principal) return reject.unauthorized();
      const row = await svc.patchConversation(
        {
          tenant_id: scope.tenant_id,
          conversation_id: id,
          actor_id: principal.id,
          actor_type: actorType(principal),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
        },
        scope.db,
      );
      return row ?? reject.notFound("conversation");
    },
    http: {
      method: "patch",
      path: "/v1/conversations/{id}",
      tags: ["conversations"],
      params: IdParam,
      body: PatchConversationBody,
      response: ConversationSchema,
      errors: { 404: "Not found" },
      toInput: ({ param, json }) => ({ id: (param as IdInput).id, body: json as PatchBody }),
      toBody: same,
    },
  });

  return { list, detail, patch };
}
