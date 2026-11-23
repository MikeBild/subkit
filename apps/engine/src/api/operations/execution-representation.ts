import { z } from "@hono/zod-openapi";
import { CredentialUseSnapshotSchema } from "../../credentials/provider-identity.ts";
import type { executionSteps, executions } from "../../db/schema/index.ts";
import { ExecutionCallerSchema } from "../../execution/caller-summary.ts";
import { PREVIEW_CLASSIFICATIONS } from "../../execution/classify.ts";
import { describeExecutionEvidence } from "../../execution/evidence.ts";
import { scrubRecordedUrls } from "../../execution/recorded-url.ts";
import { WorkflowPermissionSchema } from "../../execution/workflow-permission.ts";
import { ReportDeliveryRefusalSchema } from "../../workflows/report-delivery-boundary.ts";
import { paginatedResponse } from "../common-schemas.ts";

const ExecSchema = z
  .object({
    id: z.string(),
    execution_id: z.string(),
    error: z.object({ code: z.string() }).nullable(),
    workflow_id: z.string().nullable(),
    workflow_name: z.string().nullable(),
    workflow_version_id: z.string().nullable(),
    execution_authority_id: z.string().uuid().nullable(),
    execution_environment: z.enum(["dev", "prod"]),
    permission_basis: WorkflowPermissionSchema.shape.source.nullable(),
    permission_phase: WorkflowPermissionSchema.shape.phase.nullable(),
    permission_checked_at: WorkflowPermissionSchema.shape.checked_at.nullable(),
    hold_writes: z.boolean().optional(),
    source_kind: z.enum(["saved", "draft", "step"]),
    source_ref: z.record(z.string(), z.unknown()).nullable(),
    status: z.string(),
    waiting_reason: z
      .enum(["budget"])
      .optional()
      .describe(
        "budget: the run waits before a model step until the AI budget allows it again; it then continues by itself without repeating earlier steps.",
      ),
    request_source: z.string(),
    caller: ExecutionCallerSchema,
    parent_execution_id: z.string().nullable(),
    input: z.unknown().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Execution");

const CauseClassSchema = z.enum(PREVIEW_CLASSIFICATIONS);

const RefusedConnectorSchema = z
  .object({
    connector_id: z.string().nullable(),
    reason: z.string(),
  })
  .nullable();

const ExecutionOutcomeSchema = z
  .object({
    kind: z.enum(["succeeded", "failed", "held", "partial", "running"]),
    failed_step: z.object({ step_key: z.string(), kind: z.string() }).nullable(),
    cause_class: CauseClassSchema.nullable(),
    error_code: z.string().nullable(),
    refusal_reason: ReportDeliveryRefusalSchema.nullable(),
    connector: RefusedConnectorSchema,
    steps: z.object({
      total: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      held: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
    output_contract: z.enum(["passed", "violated", "none"]),
    rerun_safety: z.object({
      mode: z.enum(["repeat_safe", "prepare_only", "unavailable"]),
      reason: z.string(),
    }),
    planned_steps: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "Fixed request/transform step count from the persisted workflow version. Null when dynamic expansion or unavailable definition prevents an exact count.",
      ),
  })
  .openapi("ExecutionOutcome");

const RecordLinkSchema = z
  .object({
    label: z
      .string()
      .nullable()
      .describe(
        "Short record name from the external system, such as an issue key. Null when unknown.",
      ),
    url: z
      .string()
      .url()
      .describe(
        "https web address of the created or changed record on the connector's known web host.",
      ),
    connector: z.string().describe("Slug of the built-in connector template."),
    connector_name: z.string().describe("Display name of the external system."),
    step_key: z.string().describe("Step that created or changed the record."),
  })
  .openapi("ExecutionRecordLink");

export const ExecDetailSchema = ExecSchema.extend({
  trace_id: z
    .string()
    .nullable()
    .describe(
      "The unique nonempty trace recorded by successful execution-start audit entries. Null when evidence is absent, expired by retention, or conflicting. This is not inferred from the current request.",
    ),
  outcome: ExecutionOutcomeSchema,
  result_markdown: z
    .string()
    .nullable()
    .describe(
      "Human-readable run result as Markdown, redacted. Set for a succeeded run whose output_schema marks a string with contentMediaType text/markdown, or whose output has a result_markdown string. Null otherwise and always for sensitive runs.",
    ),
  result_markdown_truncated: z
    .boolean()
    .describe("True when result_markdown was cut at 64 KiB of text."),
  record_links: z
    .array(RecordLinkSchema)
    .describe(
      "Links to records that request steps created or changed in external systems, derived on read from built-in connector templates. Empty for sensitive runs, held writes, offloaded or redacted step outputs.",
    ),
}).openapi("ExecutionDetail");

const ExecListItemSchema = ExecSchema.extend({
  held_effects: z.boolean(),
  failure: z
    .object({
      step_key: z.string().nullable(),
      cause_class: CauseClassSchema.nullable(),
      refusal_reason: ReportDeliveryRefusalSchema.nullable(),
      connector: RefusedConnectorSchema,
    })
    .nullable(),
}).openapi("ExecutionListItem");

export const ExecListResponse = z
  .object({
    items: z.array(ExecListItemSchema),
    total: z.number().int().nonnegative(),
    next_cursor: z.string().nullable(),
  })
  .openapi("ExecutionListResponse");

const StepRowSchema = z
  .object({
    id: z.string(),
    step_key: z.string(),
    step_index: z.number().nullable(),
    kind: z.string(),
    status: z.string(),
    held: z.boolean(),
    duration_ms: z.number().nullable(),
    retry_count: z.number(),
    result_storage_uri: z.string().nullable(),
    result_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    result_preview: z.string().nullable(),
    output_preview: z.unknown().nullable(),
    error: z.unknown().nullable(),
    request_meta: z.unknown().nullable(),
    credential_snapshots: z.array(CredentialUseSnapshotSchema),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .openapi("ExecutionStep");

export const StepListResponse = paginatedResponse(StepRowSchema, "ExecutionStepListResponse");

export function serializeExec(
  row: typeof executions.$inferSelect,
  workflowName: string | null = null,
) {
  return {
    id: row.id,
    execution_id: row.id,
    error:
      row.status === "failed" || row.status === "timed_out"
        ? { code: row.failure?.error_code ?? row.status }
        : null,
    workflow_id: row.workflow_id ?? null,
    workflow_name: workflowName,
    workflow_version_id: row.workflow_version_id ?? null,
    ...describeExecutionEvidence(row),
    hold_writes: row.hold_writes,
    source_kind: (row.source_kind as "saved" | "draft" | "step") ?? "saved",
    source_ref: row.source_ref ?? null,
    status: row.status,
    ...(row.status === "queued" && row.budget_park ? { waiting_reason: "budget" as const } : {}),
    request_source: row.request_source,
    parent_execution_id: row.parent_execution_id ?? null,
    input: row.input ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export function serializeResultMarkdown(row: typeof executions.$inferSelect) {
  return {
    result_markdown: row.result_markdown ?? null,
    result_markdown_truncated: row.result_markdown_truncated ?? false,
  };
}

export function serializeStep(row: typeof executionSteps.$inferSelect) {
  return {
    id: row.id,
    step_key: row.step_key,
    step_index: row.step_index ?? null,
    kind: row.kind,
    status: row.status,
    held: row.held,
    duration_ms: row.duration_ms ?? null,
    retry_count: row.retry_count ?? 0,
    result_storage_uri: row.result_storage_uri ?? null,
    result_sha256: row.result_sha256 ?? null,
    result_preview: row.result_preview ?? null,
    output_preview: row.output_preview ?? null,
    error: scrubRecordedUrls(row.error ?? null),
    request_meta: scrubRecordedUrls(row.request_meta ?? null),
    credential_snapshots: row.credential_snapshots ?? [],
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
