// Workflow definition zod schemas. The shape is the user-authored DAG that
// gets persisted into `workflow_versions.dag` and consumed by the execution
// engine. P3 ships the core step kinds: request, transform, call, wait,
// branch, parallel, loop. Future phases extend with additional kinds.

import { z } from "@hono/zod-openapi";

/** Parses a multi-line "Name: Value\nOther: Other" header string into a
 *  record, trimming whitespace on both sides. Returns `null` when no
 *  valid header line was found (so validation can fail with a useful
 *  message instead of silently coercing garbage). Empty lines are
 *  tolerated; lines without a `:` are rejected. */
function parseHeaderLines(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let saw = 0;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return null;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) return null;
    out[name] = value;
    saw += 1;
  }
  return saw > 0 ? out : null;
}

// JSON value
const JsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonValue = z.infer<typeof JsonLiteralSchema> | { [k: string]: JsonValue } | JsonValue[];
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonLiteralSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

// Filter spec
//
// Scopes:
//   FIELD (default) — action applies to the matched key/value only.
//   ITEM            — action applies to the entire containing object
//                     when a descendant matches. Useful when a single
//                     marker field ("is_deleted", "redacted") means the
//                     whole record is sensitive.
//   ENTRY           — action applies to the entire top-level array
//                     element when any descendant matches. Useful for
//                     "drop rows where X is true" across a paginated
//                     response body.
export const ResponseFilterSchema = z
  .object({
    target: z.enum(["KEYS", "VALUES", "BOTH"]),
    action: z.enum(["REMOVE", "MASK", "FAIL"]),
    pattern: z.string(), // regex source
    mask: z.string().optional(),
    scope: z.enum(["FIELD", "ITEM", "ENTRY"]).optional(),
  })
  .openapi("ResponseFilter");

// Pagination spec
export const PaginationSchema = z
  .union([
    z.object({
      strategy: z.literal("offset"),
      page_size: z.number().int().positive().max(1000).default(100),
      offset_param: z.string().default("offset"),
      limit_param: z.string().default("limit"),
      stop_when_empty_path: z.string().optional(),
    }),
    z.object({
      strategy: z.literal("page"),
      page_size: z.number().int().positive().max(1000).default(100),
      page_param: z.string().default("page"),
      limit_param: z.string().default("page_size"),
      start_page: z.number().int().min(0).default(1),
    }),
    z.object({
      strategy: z.literal("cursor"),
      cursor_request_param: z.string(),
      cursor_response_path: z.string(),
      page_size: z.number().int().positive().max(1000).optional(),
      limit_param: z.string().optional(),
    }),
  ])
  .openapi("Pagination");

const onError = z.enum(["fail", "continue"]).default("fail");

type GraphQLConfig = {
  operation?: "query" | "mutation" | "subscription" | undefined;
  query: string;
  variables?: Record<string, unknown> | undefined;
};

const GraphQLConfigSchema: z.ZodType<GraphQLConfig> = z
  .object({
    operation: z.enum(["query", "mutation", "subscription"]).optional(),
    query: z.string().min(1),
    variables: z.record(z.string(), z.unknown()).optional(),
  })
  .or(
    z
      .string()
      .trim()
      .min(1, "graphql string must be a non-empty query")
      .transform((query): GraphQLConfig => ({ query })),
  );

const baseStep = {
  id: z.string().min(1),
  on_error: onError.optional(),
  data_selector: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
};

export const RequestStepSchema = z
  .object({
    kind: z.literal("request"),
    ...baseStep,
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .optional()
      .default("GET"),
    url: z.string().optional(),
    path: z.string().optional(),
    connector_id: z.string().uuid().optional(),
    // headers accepts either a record or a multi-line
    // "Name: Value" string (one per line). The string form is a
    // convenience for LLM-authored steps that often emit headers as a
    // flat block instead of an object — we coerce rather than reject
    // because the fix is trivial and the LLM would otherwise loop.
    headers: z
      .union([
        z.record(z.string(), z.string()),
        z.string().transform((raw, zctx) => {
          const parsed = parseHeaderLines(raw);
          if (!parsed) {
            zctx.addIssue({
              code: "custom",
              message: `headers string must be one or more "Name: Value" lines`,
            });
            return z.NEVER;
          }
          return parsed;
        }),
      ])
      .optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: JsonValueSchema.optional(),
    response_filters: z.array(ResponseFilterSchema).optional(),
    pagination: PaginationSchema.optional(),
    max_retries: z.number().int().min(0).max(5).optional(),
    // Override the base backoff delay (default 200ms). Clamped to [50, 10_000].
    retry_backoff_ms: z.number().int().min(50).max(10_000).optional(),
    // Additional status codes (on top of 5xx and 429) that should trigger a retry.
    // Idempotency rule still applies: non-GET/HEAD/OPTIONS methods only retry on 429
    // or codes explicitly listed here.
    retry_on_status: z.array(z.number().int().min(100).max(599)).optional(),
    // Optional GraphQL operation. When present, the request step routes
    // through the GraphQL driver instead of the HTTP retry pipeline.
    graphql: GraphQLConfigSchema.optional(),
    body_schema: z.record(z.string(), z.unknown()).optional(),
    response_schema: z.record(z.string(), z.unknown()).optional(),
    expected_statuses: z.array(z.number().int()).optional(),
    idempotency_key: z.string().optional(),
  })
  .refine((s) => s.url !== undefined || s.connector_id !== undefined, {
    message: "request step must specify either url or connector_id",
  })
  .openapi("RequestStep");

export const TransformStepSchema = z
  .object({
    kind: z.literal("transform"),
    ...baseStep,
    expression: z.string(),
    language: z.enum(["jsonata", "javascript"]).optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("TransformStep");

export const ToolStepSchema = z
  .object({
    kind: z.literal("tool"),
    ...baseStep,
    image: z.string().min(1),
    cmd: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cpu: z.number().positive().max(8).optional(),
    memory_mb: z.number().int().positive().max(16_384).optional(),
    network_mode: z.string().optional(),
    workdir: z.string().optional(),
  })
  .openapi("ToolStep");

export const CallStepSchema = z
  .object({
    kind: z.literal("call"),
    ...baseStep,
    workflow_id: z.string().uuid().optional(),
    workflow_slug: z.string().optional(),
    input: JsonValueSchema.optional(),
  })
  .openapi("CallStep");

export const WaitStepSchema = z
  .object({
    kind: z.literal("wait"),
    ...baseStep,
    duration_ms: z
      .number()
      .int()
      .min(0)
      .max(6 * 60 * 60_000),
  })
  .openapi("WaitStep");

export const BranchStepSchema = z
  .object({
    kind: z.literal("branch"),
    ...baseStep,
    when: z.string(),
    then_steps: z.array(z.string()),
    else_steps: z.array(z.string()).optional(),
  })
  .openapi("BranchStep");

// Forward refs for parallel/loop are resolved by the engine via step ids, so
// we keep the union flat — the parallel/loop steps reference children by id.
export const ParallelStepSchema = z
  .object({
    kind: z.literal("parallel"),
    ...baseStep,
    branches: z.array(z.array(z.string())),
  })
  .openapi("ParallelStep");

export const LoopStepSchema = z
  .object({
    kind: z.literal("loop"),
    ...baseStep,
    over: z.string(),
    body: z.array(z.string()),
    item_var: z.string().default("item"),
  })
  .openapi("LoopStep");

export const StepSchema = z.discriminatedUnion("kind", [
  RequestStepSchema,
  TransformStepSchema,
  CallStepSchema,
  WaitStepSchema,
  BranchStepSchema,
  ParallelStepSchema,
  LoopStepSchema,
  ToolStepSchema,
]);

export const WorkflowRuntimeSchema = z
  .object({
    // sk-stdlib version active at commit time, set by the engine when a
    // workflow contains steps with language: "javascript". Read by
    // self-healing for drift detection.
    stdlib_version: z.string().optional(),
  })
  .openapi("WorkflowRuntime");

export const WorkflowDefSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(StepSchema).min(1).max(200),
    timeout_ms: z.number().int().positive().optional(),
    runtime: WorkflowRuntimeSchema.optional(),
  })
  .openapi("WorkflowDef");

export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;
export type StepDef = z.infer<typeof StepSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type TransformStep = z.infer<typeof TransformStepSchema>;
export type CallStep = z.infer<typeof CallStepSchema>;
export type WaitStep = z.infer<typeof WaitStepSchema>;
export type BranchStep = z.infer<typeof BranchStepSchema>;
export type ParallelStep = z.infer<typeof ParallelStepSchema>;
export type LoopStep = z.infer<typeof LoopStepSchema>;
export type ToolStep = z.infer<typeof ToolStepSchema>;
export type ResponseFilter = z.infer<typeof ResponseFilterSchema>;
