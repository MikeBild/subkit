// Shared Zod schemas + serializers for the executions REST surface.
// Lifted out of a former monolithic executions.ts so list / run /
// transform / cancel can each live in their own sub-resource file
// without duplicating the Zod definitions.

import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "../../../api/common-schemas.ts";
import type { executionSteps, executions } from "../../../db/schema/index.ts";
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

// The execution list carries the exact filtered `total` alongside the
// page so consumers render "showing latest N of T" instead of
// presenting a page as the universe (ground-truth cardinality).
export const ExecListResponse = z
  .object({
    items: z.array(ExecSchema),
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
    result_preview: z.string().nullable(),
    output_preview: z.unknown().nullable(),
    error: z.unknown().nullable(),
    request_meta: z.unknown().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .openapi("ExecutionStep");

export const StepListResponse = paginatedResponse(StepRowSchema, "ExecutionStepListResponse");

// Runtime-only schema (used by the handler — full StepSchema /
// WorkflowDefSchema are too rich for the public OpenAPI catalog).
export const RuntimeRunBodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("saved"),
    workflow_id: z.string().uuid(),
    version_id: z.string().uuid().optional(),
    input: z.unknown().optional(),
    async: z.boolean().optional(),
    request_source: z
      .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
      .optional(),
  }),
  z.object({
    source: z.literal("draft"),
    definition: WorkflowDefSchema,
    name: z.string().optional(),
    input: z.unknown().optional(),
    request_source: z
      .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
      .optional(),
  }),
  z.object({
    source: z.literal("step"),
    step: StepSchema,
    workflow_slug: z.string().optional(),
    input: z.unknown().optional(),
    scope: z.record(z.string(), z.unknown()).optional(),
    timeout_ms: z.number().int().positive().max(60_000).optional(),
    request_source: z
      .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
      .optional(),
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
      workflow_id: z.string().uuid(),
      version_id: z.string().uuid().optional(),
      input: z.unknown().optional(),
      async: z.boolean().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("ExecutionRunSavedBody"),
  z
    .object({
      source: z.literal("draft"),
      definition: OpenApiDraftDefinitionSchema,
      name: z.string().optional(),
      input: z.unknown().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("ExecutionRunDraftBody"),
  z
    .object({
      source: z.literal("step"),
      step: OpenApiStepSchema,
      workflow_slug: z.string().optional(),
      input: z.unknown().optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
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
  })
  .openapi("ExecutionRunStepSummary");

export const RunResponseSchema = z
  .object({
    execution_id: z.string(),
    status: z.string(),
    output: z.unknown().optional(),
    error: z.unknown().nullable().optional(),
    steps: z.array(RunStepSummarySchema).optional(),
    connector_resolutions: z.array(ConnectorResolutionSummarySchema).optional(),
    warnings: z.array(z.unknown()).optional(),
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
    result_preview: row.result_preview ?? null,
    output_preview: row.output_preview ?? null,
    error: row.error ?? null,
    request_meta: row.request_meta ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
