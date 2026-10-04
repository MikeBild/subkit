import { z } from "@hono/zod-openapi";

export const ErrorRingEntrySchema = z
  .object({
    trace_id: z.string().nullable(),
    ts: z.string(),
    tenant_id: z.string().nullable(),
    method: z.string(),
    path: z.string(),
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
    bucket: z.enum([
      "unhandled",
      "llm_provider",
      "llm_no_object",
      "llm_timeout",
      "llm_quota",
      "http",
    ]),
  })
  .openapi("ErrorRingEntry");

export const ListResponse = z
  .object({
    items: z.array(ErrorRingEntrySchema),
    total_buffered: z.number().int(),
  })
  .openapi("DiagnosticsErrorListResponse");

export const ListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    since: z.string().datetime().optional(),
    trace_id: z.string().optional(),
  })
  .openapi("DiagnosticsErrorListQuery");

export const LlmStatusSchema = z
  .object({
    provider_env: z.string().nullable(),
    inferred_provider: z.string(),
    fallback_provider_env: z.string().nullable(),
    fallback_inferred_provider: z.string(),
    summarize_provider_env: z.string().nullable(),
    summarize_inferred_provider: z.string(),
    summarize_model: z.string().nullable(),
    summarize_configuration_error: z.string().nullable(),
    configuration_error: z.string().nullable(),
    anthropic_key_set: z.boolean(),
    gateway_key_set: z.boolean(),
    gateway_model_set: z.boolean(),
    openai_key_set: z.boolean(),
    gemini_key_set: z.boolean(),
    azure_key_set: z.boolean(),
    bedrock_key_set: z.boolean(),
    vertex_api_key_set: z.boolean(),
    vertex_service_account_set: z.boolean(),
    default_primary: z.string(),
    default_fallback: z.string(),
  })
  .openapi("DiagnosticsLlmStatus");

export const DiagnosticsRuntimeSchema = z
  .object({
    uptime_s: z.number(),
    memory: z.object({
      rss_mb: z.number(),
      heap_used_mb: z.number(),
      heap_total_mb: z.number(),
      external_mb: z.number(),
    }),
    db_pool: z.object({
      total: z.number().int(),
      idle: z.number().int(),
      waiting: z.number().int(),
    }),
    event_loop_lag_ms: z.number(),
  })
  .openapi("DiagnosticsRuntime");

export const SetupIssueSchema = z
  .object({
    id: z.string(),
    severity: z.enum(["blocker", "warning"]),
    title: z.string(),
    detail: z.string(),
  })
  .openapi("DiagnosticsSetupIssue");

export const SetupStatusSchema = z
  .enum(["ok", "warn", "blocked"])
  .openapi("DiagnosticsSetupStatus");

export const SetupValueSchema = z
  .object({
    key: z.string(),
    value: z.string().nullable(),
    status_hint: z.string().nullable(),
  })
  .openapi("DiagnosticsSetupValue");

export const SetupSectionSchema = z
  .object({
    title: z.string(),
    status: SetupStatusSchema,
    issues: z.array(SetupIssueSchema),
    recommendations: z.array(z.string()),
    values: z.array(SetupValueSchema),
  })
  .openapi("DiagnosticsSetupSection");

export const SetupSummaryCountsSchema = z
  .object({
    blockers: z.number().int(),
    warnings: z.number().int(),
    sections_blocked: z.number().int(),
    sections_warn: z.number().int(),
  })
  .openapi("DiagnosticsSetupSummaryCounts");

export const SetupSectionsSchema = z
  .object({
    auth: SetupSectionSchema,
    llm: SetupSectionSchema,
    datastore: SetupSectionSchema,
    storage: SetupSectionSchema,
    crypto: SetupSectionSchema,
    public_urls: SetupSectionSchema,
  })
  .openapi("DiagnosticsSetupSections");

export const SetupResponseSchema = z
  .object({
    overall_status: SetupStatusSchema,
    summary_counts: SetupSummaryCountsSchema,
    sections: SetupSectionsSchema,
    issues: z.array(SetupIssueSchema),
    recommendations: z.array(z.string()),
  })
  .openapi("DiagnosticsSetupResponse");

export type SetupIssue = z.infer<typeof SetupIssueSchema>;
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
export type SetupValue = z.infer<typeof SetupValueSchema>;
export type SetupSection = z.infer<typeof SetupSectionSchema>;
export type SetupResponse = z.infer<typeof SetupResponseSchema>;
