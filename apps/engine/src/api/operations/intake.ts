import { z } from "@hono/zod-openapi";
import { type Actor, actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { requireSignedInPerson } from "../../http/middleware/auth.ts";
import {
  createIntakeItem,
  deleteDiscardedIntakeItem,
  getIntakeItem,
  listIntakeCategories,
  listIntakeItems,
  patchIntakeItem,
  setIntakeDefaultCategory,
} from "../../knowledge/intake.ts";
import {
  IntakeConfirmationActorError,
  IntakeConflictError,
  IntakeNotFoundError,
} from "../../knowledge/intake-errors.ts";
import { INTAKE_ITEM_ORIGIN_FILTERS } from "../../knowledge/intake-rows.ts";
import { readIntakeItemEvidence } from "../../knowledge/intake-session.ts";
import type { IntakeItemEvidenceView, IntakeItemView } from "../../knowledge/intake-types.ts";
import { principalHolds } from "../../rbac/evaluator.ts";
import { CategorySchema } from "../catalog-metadata.ts";
import { IdParam } from "../common-schemas.ts";
import {
  defineOperation,
  isRejection,
  type OperationScope,
  type Rejection,
  reject,
} from "./index.ts";
import {
  CreateItemSchema,
  DefaultCategoryCheckSchema,
  DefaultCategorySchema,
  DeleteItemSchema,
  ITEM_EVIDENCE_LIMIT,
  ItemDetailSchema,
  ItemSchema,
  ItemStateSchema,
  ListItemsResponse,
  ListMentionItemsResponse,
  PatchItemSchema,
} from "./intake-representation.ts";

export const INTAKE_TAGS = ["intake"] as const;
export const INTAKE_READ = "intake:read";
export const INTAKE_WRITE = "intake:write";

const ListItemsQuery = z.object({
  category: CategorySchema.optional(),
  state: ItemStateSchema.optional(),
  origin: z
    .enum(INTAKE_ITEM_ORIGIN_FILTERS)
    .optional()
    .describe(
      "capture: collected from a source address; note: written without an address; session: prepared by an AI agent from a work session.",
    ),
});

const MentionQuery = z.object({
  id: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

type DefaultCategoryInput = z.infer<typeof DefaultCategorySchema>;
type ListItemsInput = z.infer<typeof ListItemsQuery>;
type MentionInput = z.infer<typeof MentionQuery>;
type CreateItemInput = z.infer<typeof CreateItemSchema>;
type PatchItemFields = z.infer<typeof PatchItemSchema>;
type DeleteItemFields = z.infer<typeof DeleteItemSchema>;

export interface IntakeIdInput<B> {
  readonly id: string;
  readonly body: B;
}

interface ItemDetail {
  readonly item: IntakeItemView;
  readonly evidence: readonly IntakeItemEvidenceView[];
  readonly evidence_total: number;
}

export interface IntakeCaller {
  readonly principal: ResolvedPrincipal;
  readonly actor: Actor;
}

export function intakeCaller(scope: OperationScope): IntakeCaller | Rejection {
  const principal = scope.principal;
  if (!principal) return reject.unauthorized();
  return { principal, actor: actorOf(principal) };
}

export function intakeFailure(error: unknown): Rejection {
  if (error instanceof IntakeNotFoundError) return reject.notFound("intake resource");
  if (error instanceof IntakeConfirmationActorError)
    return reject.status(403, "human_confirmation_required", error.message);
  if (error instanceof IntakeConflictError)
    return reject.conflict(error.message, { reason: error.name });
  throw error;
}

export function intakeIdInput<B>(param: unknown, json: unknown): IntakeIdInput<B> {
  return { id: (param as { id: string }).id, body: json as B };
}

export const getIntakeDefaultCategoryOperation = defineOperation<
  Record<string, never>,
  { category: string; can_collect: boolean }
>({
  id: "intake.get_default_category",
  summary: "Read the caller's personal default shared category",
  permission: INTAKE_READ,
  effect: "read",
  async handler(scope) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    const defaults = await listIntakeCategories(
      { tenant_id: scope.tenant_id, actor: caller.actor },
      scope.db,
    );
    return {
      category: defaults.default_category,
      can_collect: await principalHolds(scope.db, caller.principal, INTAKE_WRITE),
    };
  },
  http: {
    method: "get",
    path: "/v1/intake/default-category",
    tags: INTAKE_TAGS,
    response: DefaultCategoryCheckSchema,
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

export const setIntakeDefaultCategoryOperation = defineOperation<
  DefaultCategoryInput,
  { category: string }
>({
  id: "intake.set_default_category",
  summary: "Set the caller's personal default shared category",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_DEFAULT_CATEGORY_UPDATED,
  async handler(scope, body) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    return await setIntakeDefaultCategory(
      { tenant_id: scope.tenant_id, actor: caller.actor, ...body },
      scope.db,
    );
  },
  http: {
    method: "patch",
    path: "/v1/intake/default-category",
    tags: INTAKE_TAGS,
    body: DefaultCategorySchema,
    response: DefaultCategorySchema,
    toInput: ({ json }) => json as DefaultCategoryInput,
    toBody: (result) => result,
  },
});

export const listIntakeItemsOperation = defineOperation<ListItemsInput, IntakeItemView[]>({
  id: "intake.list_items",
  summary: "List collected clips without adding them to knowledge retrieval",
  permission: INTAKE_READ,
  effect: "read",
  handler: async (scope, query) =>
    await listIntakeItems({ tenant_id: scope.tenant_id, ...query }, scope.db),
  http: {
    method: "get",
    path: "/v1/intake/items",
    tags: INTAKE_TAGS,
    query: ListItemsQuery,
    response: ListItemsResponse,
    toInput: ({ query }) => query as ListItemsInput,
    toBody: (items) => ({ items, total: items.length }),
  },
});

export const listIntakeMentionItemsOperation = defineOperation<MentionInput, IntakeItemView[]>({
  id: "intake.list_mention_items",
  summary: "List metadata-only intake references for mentions",
  permission: INTAKE_READ,
  effect: "read",
  async handler(scope, q) {
    const items = await listIntakeItems({ tenant_id: scope.tenant_id }, scope.db);
    const needle = q.q?.toLocaleLowerCase();
    return q.id
      ? items.filter((item) => item.id === q.id)
      : needle
        ? items.filter((item) => item.title.toLocaleLowerCase().includes(needle))
        : items;
  },
  http: {
    method: "get",
    path: "/v1/intake/items/mentions",
    tags: INTAKE_TAGS,
    query: MentionQuery,
    response: ListMentionItemsResponse,
    toInput: ({ query }) => query as MentionInput,
    toBody: (items) => ({
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        source_url: item.original_snapshot.source_url ?? null,
        category: item.category,
        state: item.state,
        version: item.version,
      })),
      total: items.length,
    }),
  },
});

export const createIntakeItemOperation = defineOperation<CreateItemInput, IntakeItemView>({
  id: "intake.create_item",
  summary: "Collect an immutable source clip or a note without a source address",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_ITEM_COLLECTED,
  async handler(scope, body) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    try {
      return await createIntakeItem(
        { tenant_id: scope.tenant_id, actor: caller.actor, ...body },
        scope.db,
      );
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/intake/items",
    tags: INTAKE_TAGS,
    body: CreateItemSchema,
    response: ItemSchema,
    success: { status: 201, description: "Created" },
    errors: { 409: "Conflict" },
    toInput: ({ json }) => json as CreateItemInput,
    toBody: (item) => item,
  },
});

export const getIntakeItemOperation = defineOperation<string, ItemDetail>({
  id: "intake.get_item",
  summary: "Read an intake clip, its immutable provenance and its latest session evidence",
  permission: INTAKE_READ,
  effect: "read",
  async handler(scope, id) {
    const item = await getIntakeItem(scope.tenant_id, id, scope.db);
    if (!item) return reject.notFound("intake_item");
    const { evidence, evidence_total } = await readIntakeItemEvidence(
      { tenant_id: scope.tenant_id, item_id: item.id, limit: ITEM_EVIDENCE_LIMIT },
      scope.db,
    );
    return { item, evidence, evidence_total };
  },
  http: {
    method: "get",
    path: "/v1/intake/items/{id}",
    tags: INTAKE_TAGS,
    params: IdParam,
    response: ItemDetailSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => (param as { id: string }).id,
    toBody: ({ item, evidence, evidence_total }) => ({
      ...item,
      evidence: evidence.map((row) => ({
        id: row.id,
        agent: row.agent,
        session_id: row.session_id,
        repo: row.repo,
        excerpt: row.excerpt,
        captured_at: row.captured_at,
        recorded_by: row.recorded_by,
      })),
      evidence_total,
    }),
  },
});

export const patchIntakeItemOperation = defineOperation<
  IntakeIdInput<PatchItemFields>,
  IntakeItemView
>({
  id: "intake.patch_item",
  summary: "Organize an intake clip without changing its original source snapshot",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_ITEM_UPDATED,
  async handler(scope, { id, body }) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    try {
      const item = await patchIntakeItem(
        {
          tenant_id: scope.tenant_id,
          actor: caller.actor,
          id,
          ...body,
        },
        scope.db,
      );
      return item ?? reject.notFound("intake_item");
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "patch",
    path: "/v1/intake/items/{id}",
    tags: INTAKE_TAGS,
    params: IdParam,
    body: PatchItemSchema,
    response: ItemSchema,
    errors: { 404: "Not found", 409: "Changed" },
    toInput: ({ param, json }) => intakeIdInput<PatchItemFields>(param, json),
    toBody: (item) => item,
  },
});

export const deleteIntakeItemOperation = defineOperation<
  IntakeIdInput<DeleteItemFields>,
  "deleted"
>({
  id: "intake.delete_item",
  summary: "Permanently delete a discarded intake clip",
  permission: INTAKE_WRITE,
  effect: "write",
  audit: AuditAction.INTAKE_ITEM_DELETED,
  async handler(scope, { id, body }) {
    const caller = intakeCaller(scope);
    if (isRejection(caller)) return caller;
    requireSignedInPerson(
      caller.principal,
      "a signed-in person must permanently delete discarded intake items",
    );
    try {
      const deleted = await deleteDiscardedIntakeItem(
        { tenant_id: scope.tenant_id, actor: caller.actor, id, ...body },
        scope.db,
      );
      return deleted ? "deleted" : reject.notFound("intake_item");
    } catch (error) {
      return intakeFailure(error);
    }
  },
  http: {
    method: "delete",
    path: "/v1/intake/items/{id}",
    tags: INTAKE_TAGS,
    params: IdParam,
    body: DeleteItemSchema,
    response: z.null(),
    success: { status: 204, description: "Deleted" },
    errors: { 403: "Signed-in person required", 404: "Not found", 409: "Changed" },
    toInput: ({ param, json }) => intakeIdInput<DeleteItemFields>(param, json),
    toBody: () => null,
  },
});
