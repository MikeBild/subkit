// Workflow definition zod schemas. The shape is the user-authored DAG that
// gets persisted into `workflow_versions.dag` and consumed by the execution
// engine. P3 ships the core step kinds: request, transform, call, wait,
// branch, parallel, loop. Future phases extend with additional kinds.

import { z } from "@hono/zod-openapi";

// JSON value
const JsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonValue = z.infer<typeof JsonLiteralSchema> | { [k: string]: JsonValue } | JsonValue[];
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonLiteralSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

// Filter spec
export const ResponseFilterSchema = z
  .object({
    target: z.enum(["KEYS", "VALUES", "BOTH"]),
    action: z.enum(["REMOVE", "MASK", "FAIL"]),
    pattern: z.string(), // regex source
    mask: z.string().optional(),
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
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    body: JsonValueSchema.optional(),
    response_filters: z.array(ResponseFilterSchema).optional(),
    pagination: PaginationSchema.optional(),
    max_retries: z.number().int().min(0).max(5).optional(),
    // Optional GraphQL operation. When present, the request step routes
    // through the GraphQL driver instead of the HTTP retry pipeline.
    graphql: z
      .object({
        operation: z.enum(["query", "mutation", "subscription"]).optional(),
        query: z.string().min(1),
        variables: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
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

export const WorkflowDefSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(StepSchema).min(1).max(200),
    timeout_ms: z.number().int().positive().optional(),
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
