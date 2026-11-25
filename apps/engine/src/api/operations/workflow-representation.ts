import { z } from "@hono/zod-openapi";
import { WORKFLOW_OPERATING_STATUSES } from "@shared/workflow-operating-status.ts";
import type { Executor } from "../../db/client.ts";
import {
  EffectiveTriggerSchema,
  type TriggerBinding,
  WorkflowScheduleBindingSchema,
  workflowTriggerView,
} from "../../scheduler/trigger-bindings.ts";
import type { RecipeOrigin } from "../../workflows/index.ts";
import * as svc from "../../workflows/index.ts";
import { loadWorkflowBinding, type WorkflowListEntry } from "../../workflows/read-model.ts";
import {
  checkRecipeOrigin,
  pinnedRecipeDefinition,
  recipeDeliveryBinding,
} from "../../workflows/recipe-origin.ts";
import { TriggerSchema, type WorkflowDef } from "../../workflows/types.ts";
import { CatalogSourceSchema } from "../catalog-metadata.ts";
import { type Rejection, reject } from "./index.ts";

export const WorkflowSchema = z
  .object({
    id: z.string(),
    operating_status: z.enum(WORKFLOW_OPERATING_STATUSES).optional(),
    connector_references: z.array(
      z.object({
        step_id: z.string(),
        connector_id: z.string().nullable(),
        slug: z.string().nullable(),
        name: z.string().nullable(),
        reason: z.enum(["available", "deleted", "missing"]),
      }),
    ),
    creator: z.object({ kind: z.enum(["user", "system_account"]), id: z.string() }).nullable(),
    checksum: z.string().nullable(),
    tenant_id: z.string(),
    slug: z.string(),
    category: z
      .string()
      .describe(
        "The catalog block this workflow belongs to. One vocabulary is shared by every workflow, connector, knowledge source, skill and file of the tenant; `other` until one is assigned.",
      ),
    category_source: CatalogSourceSchema,
    name: z.string(),
    description: z.string().nullable(),
    description_source: CatalogSourceSchema,
    lifecycle: z.string(),
    current_version_id: z.string().nullable(),
    draft_version_id: z.string().nullable(),
    current_version: z.number().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    last_executed_at: z.string().nullable(),
    health_state: z.string(),
    health_reason: z.string().nullable(),
    health_changed_at: z.string().nullable(),
    invalid: z
      .boolean()
      .describe(
        "True when the current version is stored in an earlier definition format. The workflow is shown as stored; a run of it is refused with `workflow_version_invalid` until it is saved again in the current format.",
      ),
    steps: z.array(z.unknown()),
    input_schema: z.record(z.string(), z.unknown()).nullable(),
    output_schema: z.record(z.string(), z.unknown()).nullable(),
    output_transform: z.string().nullable(),
    output_transform_function: z.string().nullable(),
    response_filters: z.array(z.unknown()).nullable(),
    validation_expression: z.string().nullable(),
    validation_function: z.string().nullable(),
    timeout_ms: z.number().nullable(),
    max_llm_tokens_per_run: z.number().nullable(),
    trigger: TriggerSchema.nullable(),
    schedule: WorkflowScheduleBindingSchema.nullable(),
    webhooks_active: z.number().int().nonnegative(),
    effective_trigger: EffectiveTriggerSchema,
  })
  .openapi("Workflow");

export const WorkflowDetailSchema = WorkflowSchema.extend({
  definition: z.object({ name: z.string(), steps: z.array(z.unknown()) }).passthrough(),
}).openapi("WorkflowDetail");

const WorkflowListItemSchema = WorkflowSchema.extend({
  connectors: z.array(z.string()),
  authority_environments: z.object({
    dev: z
      .object({
        state: z.enum([
          "approved",
          "not_yet_valid",
          "expired",
          "revoked",
          "superseded",
          "exhausted",
          "invalidated",
          "unavailable",
        ]),
        ready_for_new_run: z.boolean(),
      })
      .nullable(),
    prod: z
      .object({
        state: z.enum([
          "approved",
          "not_yet_valid",
          "expired",
          "revoked",
          "superseded",
          "exhausted",
          "invalidated",
          "unavailable",
        ]),
        ready_for_new_run: z.boolean(),
      })
      .nullable(),
  }),
}).openapi("WorkflowListItem");

export const WorkflowListResponse = z
  .object({
    items: z.array(WorkflowListItemSchema),
    total: z.number().int().nonnegative(),
    categories: z.array(z.object({ category: z.string(), count: z.number().int().nonnegative() })),
  })
  .openapi("WorkflowListResponse");

export function serializeWorkflow(w: svc.WorkflowView, binding: TriggerBinding) {
  return {
    id: w.id,
    ...(w.operating_status ? { operating_status: w.operating_status } : {}),
    ...(w.authority_environments ? { authority_environments: w.authority_environments } : {}),
    connector_references: w.connector_references,
    creator: w.creator,
    checksum: w.checksum,
    tenant_id: w.tenant_id,
    slug: w.slug,
    category: w.category,
    category_source: w.category_source,
    name: w.name,
    description: w.description,
    description_source: w.description_source,
    lifecycle: w.lifecycle,
    current_version_id: w.current_version_id,
    draft_version_id: w.draft_version_id ?? null,
    current_version: w.current_version,
    created_at: w.created_at.toISOString(),
    updated_at: w.updated_at.toISOString(),
    last_executed_at: w.last_executed_at?.toISOString() ?? null,
    health_state: w.health_state,
    health_reason: w.health_reason,
    health_changed_at: w.health_changed_at?.toISOString() ?? null,
    invalid: w.invalid,
    steps: w.steps as unknown[],
    input_schema: w.definition.input_schema ?? null,
    output_schema: w.definition.output_schema ?? null,
    output_transform: w.definition.output_transform ?? null,
    output_transform_function: w.definition.output_transform_function ?? null,
    response_filters: w.definition.response_filters ?? null,
    validation_expression: w.definition.validation_expression ?? null,
    validation_function: w.definition.validation_function ?? null,
    timeout_ms: w.definition.timeout_ms ?? null,
    max_llm_tokens_per_run: w.definition.max_llm_tokens_per_run ?? null,
    trigger: w.definition.trigger ?? null,
    ...workflowTriggerView(w.definition.trigger, binding),
  };
}

export function serializeWorkflowDetail(w: svc.WorkflowView, binding: TriggerBinding) {
  return {
    ...serializeWorkflow(w, binding),
    definition: w.definition as unknown as z.infer<typeof WorkflowDetailSchema>["definition"],
  };
}

export function toWorkflowListItem(entry: WorkflowListEntry) {
  const w = entry.workflow;
  return {
    ...serializeWorkflow(w, entry.binding),
    authority_environments: w.authority_environments ?? { dev: null, prod: null },
    connectors: entry.connectors,
  };
}

export async function serializeOne(w: svc.WorkflowView, tenantId: string, db: Executor) {
  return serializeWorkflowDetail(w, await loadWorkflowBinding(tenantId, w.id, db));
}

export function recipeOriginRejection(origin: RecipeOrigin, definition: unknown): Rejection | null {
  const check = checkRecipeOrigin(origin, definition);
  return check.ok
    ? null
    : reject.unprocessable(check.message, { reason: check.reason }, "unprocessable_entity");
}

export function pinRecipeInputs<T>(
  origin: RecipeOrigin,
  definition: T,
):
  | { definition: T; binding_id?: string; rejection?: never }
  | { rejection: Rejection; definition?: never; binding_id?: never } {
  const pinned = pinnedRecipeDefinition(origin, definition);
  if (!pinned.ok)
    return {
      rejection: reject.unprocessable(
        pinned.message,
        { reason: pinned.reason },
        "unprocessable_entity",
      ),
    };
  const delivery = recipeDeliveryBinding(pinned.definition as T);
  return delivery ?? { definition: pinned.definition as T };
}

export async function bindRecipeDelivery(
  exec: Executor,
  draft: { workflow_id: string; definition: { name: string; slug?: string | undefined } },
  binding_id: string,
  actor: {
    tenant_id: string;
    actor_id: string;
    actor_type: Parameters<typeof svc.applyTriggerBindings>[6];
  },
): Promise<void> {
  await svc.applyTriggerBindings(
    exec,
    actor.tenant_id,
    draft.workflow_id,
    draft.definition.slug ?? draft.definition.name,
    draft.definition as WorkflowDef,
    actor.actor_id,
    actor.actor_type,
    binding_id,
  );
}
