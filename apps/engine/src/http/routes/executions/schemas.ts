// Shared Zod schemas + serializers for the executions REST surface.
// Lifted out of a former monolithic executions.ts so list / run /
// transform / cancel can each live in their own sub-resource file
// without duplicating the Zod definitions.

import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "../../../api/common-schemas.ts";
import type { executionSteps, executions } from "../../../db/schema/index.ts";
import { PREVIEW_CLASSIFICATIONS } from "../../../execution/classify.ts";
import { RequestMetaSchema } from "../../../execution/index.ts";
import { ResponseFilterSchema, StepSchema, WorkflowDefSchema } from "../../../workflows/index.ts";

export const ExecSchema = z
  .object({
    id: z.string(),
    /** NULL for draft and step runs (no persisted workflow row). */
    workflow_id: z.string().nullable(),
    /** Resolved workflow name so list consumers render WHAT ran, not an id. */
    workflow_name: z.string().nullable(),
    workflow_version_id: z.string().nullable(),
    execution_authority_id: z.string().uuid().nullable(),
    hold_writes: z.boolean().optional(),
    source_kind: z.enum(["saved", "draft", "step"]),
    source_ref: z.record(z.string(), z.unknown()).nullable(),
    status: z.string(),
    request_source: z.string(),
    parent_execution_id: z.string().nullable(),
    /** The caller-supplied run input (null when the run had none). */
    input: z.unknown().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Execution");

const CauseClassSchema = z.enum(PREVIEW_CLASSIFICATIONS);

// What happened in a run, as structure. `status` alone cannot say it: a
// hold-writes preview finalizes `succeeded` with nothing written (`held`), an
// `on_error:"continue"` failure leaves the run `succeeded` (`partial`). Clients
// compose their own wording from these fields; the engine sends no prose.
export const ExecutionOutcomeSchema = z
  .object({
    kind: z.enum(["succeeded", "failed", "held", "partial", "running"]),
    /** The step that stopped a failed run (or the tolerated failure of a partial one). */
    failed_step: z.object({ step_key: z.string(), kind: z.string() }).nullable(),
    cause_class: CauseClassSchema.nullable(),
    error_code: z.string().nullable(),
    steps: z.object({
      total: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      held: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
    /** `none`: no output_schema, or it was not evaluated (failed run, held preview, older run). */
    output_contract: z.enum(["passed", "violated", "none"]),
  })
  .openapi("ExecutionOutcome");

export const ExecDetailSchema = ExecSchema.extend({
  outcome: ExecutionOutcomeSchema,
}).openapi("ExecutionDetail");

export const ExecListItemSchema = ExecSchema.extend({
  /**
   * Failed runs only: the step that stopped the run (null for a
   * workflow-level failure such as `validation_failed`) and its cause class.
   */
  failure: z
    .object({ step_key: z.string().nullable(), cause_class: CauseClassSchema.nullable() })
    .nullable(),
}).openapi("ExecutionListItem");

// The execution list carries the exact filtered `total` alongside the
// page so consumers render "showing latest N of T" instead of
// presenting a page as the universe (ground-truth cardinality).
export const ExecListResponse = z
  .object({
    items: z.array(ExecListItemSchema),
    /** Exact tenant-scoped count under the same filters (ignores limit/offset). */
    total: z.number().int().nonnegative(),
    next_cursor: z.string().nullable().optional(),
  })
  .openapi("ExecutionListResponse");

export const StepRowSchema = z
  .object({
    id: z.string(),
    step_key: z.string(),
    step_index: z.number().nullable(),
    kind: z.string(),
    status: z.string(),
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
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .openapi("ExecutionStep");

export const StepListResponse = paginatedResponse(StepRowSchema, "ExecutionStepListResponse");

/** A caller-chosen key that makes a saved-workflow trigger safe to repeat.
 *  Two POSTs with the same key in one tenant produce one run; the second
 *  answers with the first run's id and `idempotent_replay: true`. Scoped to
 *  the tenant, never expires, and is the caller's to choose — a request id,
 *  an event id, a `<workflow>:<hour>` slot. */
export const IdempotencyKeySchema = z.string().min(1).max(200).openapi({
  description:
    "Caller-chosen key that makes this trigger safe to repeat: a second run with the same key in this tenant is not started; the response carries the first run's id and idempotent_replay: true. Choose a request id, an event id or a time slot.",
  example: "orders-sync:2026-09-03T07",
});

// Runtime-only schema (used by the handler — full StepSchema /
// WorkflowDefSchema are too rich for the public OpenAPI catalog).
const HoldWritesPreviewSchema = z.literal(true).optional().openapi({
  description:
    "Temporary definitions always hold writes and unknown effects, including when this flag is omitted. Reads still execute against real systems. This flag is not a live-execution authorization.",
});

const SavedRunModeSchema = z.boolean().optional().openapi({
  description:
    "Omit to discover an existing matching local authority or run a held preparation. True always holds writes without spending a live run. False requires live authorization and rejects a missing or changed authority.",
});

// The engine records a run's origin from who authenticated the request: a
// verified cockpit session is "ui", MCP / webhook / chat have their own entry
// paths, and "scheduler" is written only by the scheduler itself — it feeds
// the production-incident count, so no client may claim it. The one thing the
// context cannot see is which program holds an API key, so a key-bearing
// caller may still say "cli"; under any other origin the field is ignored.
const CLIENT_DECLARED_RUN_SOURCES = ["api", "cli"] as const;
export type ClientDeclaredRunSource = (typeof CLIENT_DECLARED_RUN_SOURCES)[number];
export const ClientDeclaredRunSourceSchema = z
  .enum(CLIENT_DECLARED_RUN_SOURCES, {
    error: `request_source may only be ${CLIENT_DECLARED_RUN_SOURCES.join(" or ")}; every other origin is recorded by the engine from who started the run, never declared by the caller`,
  })
  .optional()
  .openapi({
    description:
      "Which program holds the API key: api or cli. Honoured only when the credential is an API key; ignored for a verified cockpit session, an MCP token or any other credential. Every other origin (scheduler, mcp, webhook, chat, tool-chain) is recorded by the engine and rejected here.",
  });

export const RuntimeRunBodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("saved"),
    hold_writes: SavedRunModeSchema,
    workflow_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
    execution_authority_id: z.string().uuid().optional(),
    input: z.unknown().optional(),
    async: z.boolean().optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
    request_source: ClientDeclaredRunSourceSchema,
  }),
  z.object({
    source: z.literal("draft"),
    hold_writes: HoldWritesPreviewSchema,
    definition: WorkflowDefSchema,
    name: z.string().optional(),
    input: z.unknown().optional(),
    request_source: ClientDeclaredRunSourceSchema,
  }),
  z.object({
    source: z.literal("step"),
    hold_writes: HoldWritesPreviewSchema,
    step: StepSchema,
    workflow_slug: z.string().optional(),
    input: z.unknown().optional(),
    scope: z.record(z.string(), z.unknown()).optional(),
    timeout_ms: z.number().int().positive().max(60_000).optional(),
    request_source: ClientDeclaredRunSourceSchema,
  }),
]);

const OpenApiDraftDefinitionSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    timeout_ms: z.number().int().positive().optional(),
  })
  .openapi("ExecutionRunDraftDefinition");

const OpenApiStepSchema = z
  .object({ kind: z.string().min(1) })
  .catchall(z.unknown())
  .openapi("ExecutionRunStep");

export const RunBodySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("saved"),
      hold_writes: SavedRunModeSchema,
      workflow_id: z.string().uuid(),
      version_id: z.string().uuid().optional(),
      execution_authority_id: z.string().uuid().optional().openapi({
        description:
          "Use an existing human-granted execution authority. Its exact version, environment, manifest, validity and remaining runs are checked by the server; this field never grants authority.",
      }),
      input: z.unknown().optional(),
      async: z.boolean().optional(),
      idempotency_key: IdempotencyKeySchema.optional(),
      request_source: ClientDeclaredRunSourceSchema,
    })
    .openapi("ExecutionRunSavedBody"),
  z
    .object({
      source: z.literal("draft"),
      hold_writes: HoldWritesPreviewSchema,
      definition: OpenApiDraftDefinitionSchema,
      name: z.string().optional(),
      input: z.unknown().optional(),
      request_source: ClientDeclaredRunSourceSchema,
    })
    .openapi("ExecutionRunDraftBody"),
  z
    .object({
      source: z.literal("step"),
      hold_writes: HoldWritesPreviewSchema,
      step: OpenApiStepSchema,
      workflow_slug: z.string().optional(),
      input: z.unknown().optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      request_source: ClientDeclaredRunSourceSchema,
    })
    .openapi("ExecutionRunStepBody"),
]);

// Mirrors `AppliedAuthMethod` in execution/types.ts — the run result's
// connector rollup emits every member, so the response schema must too.
const AppliedAuthMethodEnum = z.enum([
  "none",
  "bearer",
  "header",
  "query",
  "basic",
  "oauth2_static",
  "oauth2_refreshed",
  "aws_sigv4",
  "token_mint_static",
  "token_mint_refreshed",
  "oauth2_client",
  "oauth2_private_key",
]);

const ConnectorResolutionSummarySchema = z
  .object({
    step_key: z.string(),
    connector_id: z.string(),
    connector_slug: z.string(),
    driver: z.string(),
    requested_environment: z.enum(["dev", "prod"]),
    resolved_environment: z.enum(["dev", "prod"]),
    auth_method: AppliedAuthMethodEnum,
    base_url: z.string().nullable().optional(),
  })
  .openapi("ConnectorResolutionSummary");

const RunStepSummarySchema = z
  .object({
    step_key: z.string(),
    step_index: z.number().int(),
    kind: z.string(),
    status: z.string(),
    duration_ms: z.number().nullable(),
    retry_count: z.number().int(),
    error: z.unknown().nullable(),
    request_meta: RequestMetaSchema.nullable().optional(),
    /** A preview prepared this step but did not dispatch its write. */
    held: z.boolean().optional(),
  })
  .openapi("ExecutionRunStepSummary");

export const RunResponseSchema = z
  .object({
    execution_id: z.string(),
    status: z.string(),
    hold_writes: z.boolean().optional(),
    output: z.unknown().optional(),
    error: z.unknown().nullable().optional(),
    steps: z.array(RunStepSummarySchema).optional(),
    connector_resolutions: z.array(ConnectorResolutionSummarySchema).optional(),
    warnings: z.array(z.unknown()).optional(),
    /** Present and true when the request carried an idempotency_key that an
     *  earlier run already used: no new run was started, execution_id and
     *  status are that run's. */
    idempotent_replay: z.boolean().optional(),
  })
  .openapi("ExecutionRunResponse");

export const RunTransformBodySchema = z
  .object({
    output_transform: z.string().min(1).optional(),
    output_transform_function: z.string().min(1).optional(),
    response_filters: z.array(ResponseFilterSchema).optional(),
    payload: z.unknown(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    timeout_ms: z.number().int().positive().max(60_000).optional(),
  })
  .refine(
    (b) =>
      Boolean(b.output_transform) ||
      Boolean(b.output_transform_function) ||
      (b.response_filters && b.response_filters.length > 0),
    {
      message:
        "either `output_transform`, `output_transform_function`, or at least one `response_filters` entry is required",
    },
  )
  .refine((b) => !(b.output_transform && b.output_transform_function), {
    message:
      "set either `output_transform` (JSONata) or `output_transform_function` (JS), not both",
  })
  .openapi("ExecutionRunTransformBody");

export const RunTransformResponseSchema = z
  .object({
    output: z.unknown(),
    duration_ms: z.number().int().nonnegative(),
  })
  .openapi("ExecutionRunTransformResponse");

export function serializeExec(
  row: typeof executions.$inferSelect,
  workflowName: string | null = null,
) {
  return {
    id: row.id,
    workflow_id: row.workflow_id ?? null,
    workflow_name: workflowName,
    workflow_version_id: row.workflow_version_id ?? null,
    execution_authority_id: row.execution_authority_id ?? null,
    hold_writes: row.hold_writes,
    source_kind: (row.source_kind as "saved" | "draft" | "step") ?? "saved",
    source_ref: row.source_ref ?? null,
    status: row.status,
    request_source: row.request_source,
    parent_execution_id: row.parent_execution_id ?? null,
    input: row.input ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export function serializeStep(row: typeof executionSteps.$inferSelect) {
  return {
    id: row.id,
    step_key: row.step_key,
    step_index: row.step_index ?? null,
    kind: row.kind,
    status: row.status,
    duration_ms: row.duration_ms ?? null,
    retry_count: row.retry_count ?? 0,
    result_storage_uri: row.result_storage_uri ?? null,
    result_sha256: row.result_sha256 ?? null,
    result_preview: row.result_preview ?? null,
    output_preview: row.output_preview ?? null,
    error: row.error ?? null,
    request_meta: row.request_meta ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
