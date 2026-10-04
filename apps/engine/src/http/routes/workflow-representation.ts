// The workflow representation every workflow route returns (list, detail,
// create, update, metadata, restore) and its serializer. Lifted out of
// workflows.ts so the route file stays about routes.

import { z } from "@hono/zod-openapi";
import type { Executor } from "../../db/client.ts";
import {
  bindingFor,
  EffectiveTriggerSchema,
  loadTriggerBindings,
  type TriggerBinding,
  WorkflowScheduleBindingSchema,
  workflowTriggerView,
} from "../../scheduler/index.ts";
import type * as svc from "../../workflows/index.ts";
import { TriggerSchema } from "../../workflows/index.ts";

export const WorkflowSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    lifecycle: z.string(),
    current_version_id: z.string().nullable(),
    draft_version_id: z.string().nullable(),
    current_version: z.number().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    // When this workflow last ran, and how it is doing. Both are stored on
    // the workflow row and were previously readable only through
    // `GET /v1/diagnostics/integrations`, which forced a catalog client to
    // make a second, differently-permissioned request to answer "did this
    // ever run" — the two surfaces report the same strings.
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
    // The workflow's trigger (schedule / webhook / request). Surfaced so
    // GET is symmetric with the create/update request body and the MCP
    // get_workflow definition — non-MCP callers (and the `sk` CLI banner)
    // previously couldn't read the trigger from the bare HTTP response.
    trigger: TriggerSchema.nullable(),
    // What really starts the workflow. `trigger` above is only what the
    // definition declares; the scheduler fires from the bound
    // `workflows_schedules` row, which `POST /v1/schedules` creates without
    // touching the definition, and deliveries arrive through active
    // `webhooks_inbound` rows. A client that reads `trigger` alone reports an
    // hourly schedule as "on request".
    schedule: WorkflowScheduleBindingSchema.nullable(),
    webhooks_active: z.number().int().nonnegative(),
    effective_trigger: EffectiveTriggerSchema,
  })
  .openapi("Workflow");

// A workflow AS IT APPEARS IN THE CATALOG. `category` and `connectors` are
// derived, not stored: the category emerges from the whole slug corpus
// (`workflows/categorize.ts`) and the connector list from the current version's
// DAG (`workflows/connector-refs.ts`). They live on the list item rather than
// on `Workflow` because both are catalog-level facts — deriving them would cost
// an extra pass on every single-workflow fetch that has no use for them.
const WorkflowListItemSchema = WorkflowSchema.extend({
  category: z.string(),
  connectors: z.array(z.string()),
}).openapi("WorkflowListItem");

export const WorkflowListResponse = z
  .object({
    items: z.array(WorkflowListItemSchema),
    /** Exact tenant-scoped count under the same filters (ignores limit/offset). */
    total: z.number().int().nonnegative(),
    /**
     * The blocks present in `items`, in render order (largest first, the
     * catch-all last). Emitted so every client — `sk`, a dashboard, an agent —
     * renders the same order without re-deriving the rule.
     */
    categories: z.array(z.object({ category: z.string(), count: z.number().int().nonnegative() })),
  })
  .openapi("WorkflowListResponse");

export function serializeWorkflow(w: svc.WorkflowView, binding: TriggerBinding) {
  return {
    id: w.id,
    tenant_id: w.tenant_id,
    slug: w.slug,
    name: w.name,
    // Same precedence as the `wf_<slug>` catalog: the editable
    // workflows.description column wins, then the DAG's authoring-time
    // description, then null. Keeps the HTTP/dashboard surface in lock-step
    // with what the MCP tool palette shows.
    description: w.description ?? w.definition.description ?? null,
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
    // Schema fields surfaced for non-MCP HTTP callers (CI smoke tests,
    // SDK clients, external orchestrators). MCP exposes them via the
    // tool-definition surface; the bare HTTP GET previously omitted
    // them, forcing callers to round-trip through MCP just to learn
    // a workflow's input shape. The HTTP GET exposes
    // `input_schema` / `output_schema` directly.
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

/** One workflow, serialized with its trigger bindings read in the same call. */
export async function serializeOne(w: svc.WorkflowView, tenantId: string, db: Executor) {
  const bindings = await loadTriggerBindings(tenantId, [w.id], db);
  return serializeWorkflow(w, bindingFor(bindings, w.id));
}
