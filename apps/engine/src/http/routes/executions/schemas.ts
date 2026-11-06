import { z } from "@hono/zod-openapi";
import { RequestMetaSchema } from "../../../execution/index.ts";
import { ResponseFilterSchema, StepSchema, WorkflowDefSchema } from "../../../workflows/index.ts";

const IdempotencyKeySchema = z.string().min(1).max(200).openapi({
  description:
    "Caller-chosen key that makes this trigger safe to repeat: a second run with the same key in this tenant is not started; the response carries the first run's id and idempotent_replay: true. Choose a request id, an event id or a time slot.",
  example: "orders-sync:2026-09-03T07",
});

const HoldWritesPreviewSchema = z.literal(true).optional().openapi({
  description:
    "Temporary definitions always hold writes and unknown effects, including when this flag is omitted. Reads still execute against real systems. This flag is not a live-execution authorization.",
});

const SavedRunModeSchema = z.boolean().optional().openapi({
  description:
    "Omit to discover an existing matching local authority or run a held preparation. True always holds writes without spending a live run. False requires live authorization and rejects a missing or changed authority.",
});

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

function savedWhenUnnamed(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  return record.source === undefined && record.workflow_id !== undefined
    ? { ...record, source: "saved" }
    : body;
}

const RuntimeRunBodyVariants = z.discriminatedUnion("source", [
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

export const RuntimeRunBodySchema = z.preprocess(savedWhenUnnamed, RuntimeRunBodyVariants);

const OpenApiDraftDefinitionSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    execution_privacy: WorkflowDefSchema.shape.execution_privacy,
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

const RunBodyVariants = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("saved").openapi({
        description: "May be omitted when workflow_id is present.",
      }),
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

export const RunBodySchema = z.preprocess(savedWhenUnnamed, RunBodyVariants);

const AppliedAuthMethodEnum = z.enum([
  "none",
  "bearer",
  "header",
  "query",
  "basic",
  "oauth2_static",
  "oauth2_refreshed",
  "aws_sigv4",
  "signed_jwt",
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

export const CallerBudgetRefusalSchema = z
  .object({
    error: z.enum(["rate-limited", "turn-busy", "turn-limit", "invalid"]),
    code: z.enum(["rate_limited", "turn_busy", "turn_limit", "invalid"]),
    message: z.string(),
    usage: z.object({ usedToday: z.number().int(), dailyLimit: z.number().int() }).optional(),
  })
  .openapi("CallerBudgetRefusal");
