import { z } from "@hono/zod-openapi";
import { FileRefSchema } from "../api/files-schemas.ts";
import { ReportDeliveryBoundarySchema } from "./report-delivery-boundary.ts";
import { RequestBoundaryScopeSchema } from "./request-boundary.ts";
import { StorageScopeSchema } from "./storage-boundary.ts";
import { looksLikeJsonObjectOrArray, parseHeaderLines } from "./types-helpers.ts";
import {
  MarkdownConfigSchema,
  ReadabilityConfigSchema,
  StructuredDataConfigSchema,
  TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION,
  TRANSFORM_LANGUAGES_NEEDING_EXPRESSION,
} from "./types-web-scraper.ts";

export type {
  MarkdownOutput,
  ReadabilityOutput,
  StructuredDataOutput,
} from "./types-web-scraper.ts";
export {
  MarkdownOutputSchema,
  ReadabilityOutputSchema,
  StructuredDataOutputSchema,
} from "./types-web-scraper.ts";

const JsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type JsonValue = z.infer<typeof JsonLiteralSchema> | { [k: string]: JsonValue } | JsonValue[];
export const JsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      JsonLiteralSchema,
      FileRefSchema as z.ZodType<JsonValue>,
      z.array(JsonValueSchema),
      z.record(z.string(), JsonValueSchema),
    ]),
  )
  .openapi("WorkflowJsonValue");

export const ResponseFilterSchema = z
  .object({
    target: z.enum(["KEYS", "VALUES", "BOTH"]),
    action: z.enum(["REMOVE", "MASK", "FAIL"]),
    pattern: z.string(),
    mask: z.string().optional(),
    scope: z.enum(["FIELD", "ITEM", "ENTRY"]).optional(),
  })
  .openapi("ResponseFilter");

export const PaginationSchema = z
  .union([
    z.object({
      strategy: z.literal("offset"),
      page_size: z.number().int().positive().max(100_000).default(100),
      offset_param: z.string().default("offset"),
      limit_param: z.string().default("limit"),
      parameter_location: z.enum(["query", "body"]).optional(),
      output_mode: z.enum(["items", "pages"]).optional(),
      items_path: z.string().optional(),
      stop_when_empty_path: z.string().optional(),
      max_pages: z.number().int().positive().max(1000).optional(),
    }),
    z.object({
      strategy: z.literal("page"),
      page_size: z.number().int().positive().max(100_000).default(100),
      page_param: z.string().default("page"),
      limit_param: z.string().default("page_size"),
      start_page: z.number().int().min(0).default(1),
      parameter_location: z.enum(["query", "body"]).optional(),
      output_mode: z.enum(["items", "pages"]).optional(),
      items_path: z.string().optional(),
      max_pages: z.number().int().positive().max(1000).optional(),
    }),
    z.object({
      strategy: z.literal("cursor"),
      cursor_request_param: z.string(),
      cursor_response_path: z.string(),
      page_size: z.number().int().positive().max(100_000).optional(),
      limit_param: z.string().optional(),
      parameter_location: z.enum(["query", "body"]).optional(),
      output_mode: z.enum(["items", "pages"]).optional(),
      items_path: z.string().optional(),
      max_pages: z.number().int().positive().max(1000).optional(),
    }),
  ])
  .openapi("Pagination");

const onError = z.enum(["fail", "continue"]).default("fail");

const errorPolicy = z.enum(["none", "all"]).default("none");

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
      .transform((query, zctx): GraphQLConfig => {
        if (looksLikeJsonObjectOrArray(query)) {
          zctx.addIssue({
            code: "custom",
            message:
              'graphql config must be an object {query, variables?} or a raw GraphQL document — got a JSON-encoded string. Pass `{query: "..."}` instead of `\'{"query":"..."}\'`.',
          });
          return z.NEVER as unknown as GraphQLConfig;
        }
        return { query };
      }),
  );

export const MultipartPartSchema = z
  .object({
    name: z.string().min(1),
    file: FileRefSchema.optional(),
    value: z.string().optional(),
    filename: z.string().optional(),
    content_type: z.string().optional(),
  })
  .refine((p) => p.file !== undefined || p.value !== undefined, {
    message: "multipart part must have either `file` or `value`",
  })
  .openapi("MultipartPart");

export type MultipartPart = z.infer<typeof MultipartPartSchema>;

export const InputSchemaFileNodeSchema = z
  .object({
    type: z.literal("file"),
    accept: z.array(z.string()).optional(),
    max_size_bytes: z.number().int().positive().optional(),
    multiple: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .openapi("InputSchemaFileNode");

const baseStep = {
  id: z.string().min(1),
  on_error: onError.optional(),
  data_selector: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  for_each: z.string().optional(),
  for_each_concurrency: z.number().int().min(1).optional(),
};

export const RequestStepSchema = z
  .object({
    kind: z.literal("request"),
    ...baseStep,
    method: z
      .enum([
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "LIST",
        "SELECT",
        "INSERT",
        "UPDATE",
        "CALL",
      ])
      .optional()
      .default("GET"),
    side_effects: z.enum(["read", "write"]).optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    connector_id: z.string().uuid().optional(),
    boundary: RequestBoundaryScopeSchema.optional(),
    report_delivery: ReportDeliveryBoundarySchema.optional(),
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
    retry_backoff_ms: z.number().int().min(50).max(10_000).optional(),
    retry_on_status: z.array(z.number().int().min(100).max(599)).optional(),
    graphql: GraphQLConfigSchema.optional(),
    error_policy: errorPolicy.optional(),
    xml: z
      .object({
        body: JsonValueSchema,
        declaration: z.boolean().optional(),
      })
      .optional(),
    sql: z
      .object({
        query: z.string().min(1),
        params: z.array(z.unknown()).optional(),
        also: z
          .array(
            z.object({
              query: z.string().min(1),
              params: z.array(z.unknown()).optional(),
              expected_row_count: z
                .union([
                  z.number().int().min(0),
                  z.tuple([z.number().int().min(0), z.number().int().min(0)]),
                  z
                    .object({
                      min: z.number().int().min(0).optional(),
                      max: z.number().int().min(0).optional(),
                    })
                    .refine((v) => v.min !== undefined || v.max !== undefined, {
                      message: "expected_row_count requires `min` and/or `max`",
                    }),
                ])
                .optional(),
            }),
          )
          .optional(),
        transaction: z.boolean().optional(),
        cursor: z
          .object({
            fetch_size: z.number().int().positive().max(10_000).default(1000),
          })
          .optional(),
      })
      .optional(),
    s3: z
      .object({
        scope: StorageScopeSchema.optional(),
        key: z.string().optional(),
        prefix: z.string().optional(),
        parse_as: z.enum(["json", "text", "base64", "bytes"]).optional(),
        max_keys: z.number().int().positive().max(10_000).optional(),
        content_type: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        paginate: z.boolean().optional(),
        multipart: z.boolean().optional(),
        multipart_threshold_mb: z.number().positive().max(1024).optional(),
        range: z.string().optional(),
        presign: z
          .object({
            expires_in_s: z
              .number()
              .int()
              .positive()
              .max(7 * 24 * 3600)
              .default(900),
          })
          .optional(),
      })
      .optional(),
    mcp: z
      .object({
        operation: z.enum(["call_tool", "read_resource", "get_prompt"]).default("call_tool"),
        tool: z.string().min(1).optional(),
        uri: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        arguments: z.record(z.string(), JsonValueSchema).optional(),
      })
      .superRefine((m, ctx) => {
        const required = {
          call_tool: "tool",
          read_resource: "uri",
          get_prompt: "prompt",
        } as const;
        const field = required[m.operation];
        if (m[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `mcp.operation "${m.operation}" requires mcp.${field}`,
          });
        }
        for (const [other, forOp] of Object.entries(required) as Array<
          [keyof typeof required, (typeof required)[keyof typeof required]]
        >) {
          if (other === m.operation) continue;
          if (m[forOp] !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [forOp],
              message: `mcp.${forOp} belongs to operation "${other}", not "${m.operation}"`,
            });
          }
        }
        if (m.operation === "read_resource" && m.arguments !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["arguments"],
            message: "mcp.arguments is not accepted by read_resource — a resource is named by uri",
          });
        }
      })
      .optional(),
    body_schema: z.record(z.string(), z.unknown()).optional(),
    response_schema: z.record(z.string(), z.unknown()).optional(),
    expected_statuses: z.array(z.number().int()).optional(),
    expected_row_count: z
      .union([
        z.number().int().min(0),
        z.tuple([z.number().int().min(0), z.number().int().min(0)]),
        z
          .object({
            min: z.number().int().min(0).optional(),
            max: z.number().int().min(0).optional(),
          })
          .refine((v) => v.min !== undefined || v.max !== undefined, {
            message: "expected_row_count object must set at least one of `min` or `max`",
          }),
      ])
      .optional(),
    idempotency_key: z.string().optional(),
    outputs: z.record(z.string().min(1), z.object({ secret: z.boolean().optional() })).optional(),
    state_read: z
      .object({
        key: z.string().min(1),
        into_var: z.string().min(1),
        default_value: z.unknown().optional(),
      })
      .optional(),
    state_write: z
      .object({
        key: z.string().min(1),
        value_path: z.string().min(1),
      })
      .optional(),
    multipart: z.array(MultipartPartSchema).min(1).optional(),
  })
  .refine((s) => s.url !== undefined || s.connector_id !== undefined || s.sql !== undefined, {
    message:
      "request step must specify either url, connector_id, or sql (postgres connectors are routed via the sql block)",
  })
  .superRefine((s, ctx) => {
    const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    const S3_VERBS = new Set(["GET", "PUT", "HEAD", "DELETE", "LIST"]);
    const SQL_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "CALL"]);

    if (
      s.side_effects === "read" &&
      s.graphql === undefined &&
      s.sql === undefined &&
      s.mcp === undefined &&
      ["PUT", "PATCH", "DELETE"].includes(s.method ?? "GET")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["side_effects"],
        message: `side_effects:"read" cannot downgrade mutating method ${s.method}`,
      });
    }

    if (s.s3 !== undefined) {
      if (s.method !== undefined && !S3_VERBS.has(s.method)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["method"],
          message: `s3 step requires method ∈ ${[...S3_VERBS].join("|")}, got ${s.method}`,
        });
      }
      const effective = (s.method ?? "GET") as string;
      if (effective === "LIST" && !s.s3.prefix) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["s3", "prefix"],
          message: "s3 LIST requires a prefix",
        });
      }
      if (effective !== "LIST" && !s.s3.key && !s.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["s3", "key"],
          message: `s3 ${effective} requires either s3.key or step.path`,
        });
      }
    }

    const validateExpectation = (val: unknown, path: (string | number)[]): void => {
      if (Array.isArray(val) && val.length === 2) {
        const [lo, hi] = val as [number, number];
        if (lo > hi) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `expected_row_count tuple [${lo}, ${hi}] has lo > hi (unsatisfiable)`,
          });
        }
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as { min?: number; max?: number };
        if (obj.min !== undefined && obj.max !== undefined && obj.min > obj.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `expected_row_count { min: ${obj.min}, max: ${obj.max} } has min > max (unsatisfiable)`,
          });
        }
      }
    };
    if (s.expected_row_count !== undefined) {
      validateExpectation(s.expected_row_count, ["expected_row_count"]);
    }
    if (s.sql?.also) {
      s.sql.also.forEach((stmt, idx) => {
        if (stmt.expected_row_count !== undefined) {
          validateExpectation(stmt.expected_row_count, ["sql", "also", idx, "expected_row_count"]);
        }
      });
    }

    if (s.sql !== undefined && s.expected_statuses !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected_statuses"],
        message: "expected_statuses is HTTP/S3 only; postgres steps use expected_row_count",
      });
    }
    if (s.s3 !== undefined && s.expected_row_count !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected_row_count"],
        message: "expected_row_count is postgres-only; s3 steps use expected_statuses",
      });
    }
    if (
      s.s3 === undefined &&
      s.sql === undefined &&
      s.graphql === undefined &&
      s.mcp === undefined &&
      s.expected_row_count !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected_row_count"],
        message: "expected_row_count is postgres-only; HTTP steps use expected_statuses",
      });
    }

    if (s.sql !== undefined) {
      const methodStr: string | undefined = s.method;
      if (
        methodStr !== undefined &&
        !SQL_VERBS.has(methodStr) &&
        methodStr !== "GET" &&
        HTTP_VERBS.has(methodStr)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["method"],
          message: `sql step requires method ∈ ${[...SQL_VERBS].join("|")}, got ${methodStr}`,
        });
      }
      if (s.sql.transaction === false && s.sql.also && s.sql.also.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sql", "transaction"],
          message: "sql.transaction cannot be false when sql.also is set",
        });
      }
      if (s.sql.cursor !== undefined && s.sql.also !== undefined && s.sql.also.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sql", "cursor"],
          message:
            "sql.cursor cannot be combined with sql.also (the cursor opens its own transaction)",
        });
      }
    }

    if (s.mcp !== undefined) {
      if (s.connector_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["connector_id"],
          message: "mcp step requires connector_id — an MCP server is addressed as a connector",
        });
      }
      if (s.expected_statuses !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_statuses"],
          message: "expected_statuses is HTTP/S3 only; an MCP call has no HTTP status",
        });
      }
      if (s.expected_row_count !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_row_count"],
          message: "expected_row_count is postgres-only; an MCP call returns content, not rows",
        });
      }
      if (s.timeout_ms !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeout_ms"],
          message:
            "timeout_ms does not bound an mcp step; the deadline for a remote call is the connector's `config.mcp.remote_tool_call_timeout_ms` (tenant default: `connectors.mcp.remote_tool_call_timeout_ms`, ceiling 300000ms)",
        });
      }
    }

    if (
      s.s3 === undefined &&
      s.sql === undefined &&
      s.graphql === undefined &&
      s.mcp === undefined &&
      s.method !== undefined &&
      !HTTP_VERBS.has(s.method)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: `http request step requires method ∈ ${[...HTTP_VERBS].join("|")}, got ${s.method}; add an \`s3\`, \`sql\` or \`mcp\` block to dispatch through those drivers`,
      });
    }
  })
  .openapi("RequestStep");

export const TransformStepSchema = z
  .object({
    kind: z.literal("transform"),
    ...baseStep,
    expression: z.string().optional(),
    language: z
      .enum(["javascript", "readability", "html-to-markdown", "structured-data"])
      .optional(),
    readability: ReadabilityConfigSchema.optional(),
    markdown: MarkdownConfigSchema.optional(),
    structured_data: StructuredDataConfigSchema.optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    silence_warnings: z
      .array(z.enum(["dropped_fields"]))
      .optional()
      .openapi({ description: "Suppress specific non-fatal warnings on this step." }),
  })
  .superRefine((s, ctx) => {
    const language = s.language ?? "javascript";
    if (TRANSFORM_LANGUAGES_NEEDING_EXPRESSION.has(language)) {
      if (s.expression === undefined || s.expression.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expression"],
          message: `transform.language=${language} requires a non-empty expression`,
        });
      }
    }
    if (TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION.has(language)) {
      if (s.expression !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expression"],
          message: `transform.language=${language} does not accept an expression; configure via the \`${language === "html-to-markdown" ? "markdown" : language === "structured-data" ? "structured_data" : "readability"}\` block`,
        });
      }
    }
    if (s.readability !== undefined && language !== "readability") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readability"],
        message: 'readability config is only valid when language="readability"',
      });
    }
    if (s.markdown !== undefined && language !== "html-to-markdown") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["markdown"],
        message: 'markdown config is only valid when language="html-to-markdown"',
      });
    }
    if (s.structured_data !== undefined && language !== "structured-data") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["structured_data"],
        message: 'structured_data config is only valid when language="structured-data"',
      });
    }
    if (language === "javascript" && typeof s.expression === "string" && s.expression.length > 0) {
      const jsonataMarker = /~>/;
      if (jsonataMarker.test(s.expression)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expression"],
          message:
            "expression uses the JSONata pipe operator (`~>`), but transforms are JavaScript. Rewrite the body in JavaScript — a transform is a function body that `return`s its result, addressing upstream data as `input.scope.<step>.data`.",
          params: { error_code: "language_mismatch", suggested_language: "javascript" },
        });
      }
    }
  })
  .openapi("TransformStep");

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
      .max(24 * 60 * 60_000),
  })
  .openapi("WaitStep");

export const WaitForEventStepSchema = z
  .object({
    kind: z.literal("wait_for_event"),
    ...baseStep,
    event_name: z.string().min(1),
    match: z
      .object({
        path: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .optional(),
    timeout_ms: z.number().int().positive(),
    on_timeout: z.string().min(1).optional(),
  })
  .openapi("WaitForEventStep");

export const BranchStepSchema = z
  .object({
    kind: z.literal("branch"),
    ...baseStep,
    when: z.string(),
    then_steps: z.array(z.string()),
    else_steps: z.array(z.string()).optional(),
  })
  .openapi("BranchStep");

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
    over: z.string().optional(),
    data_selector: z.string().optional(),
    body: z.array(z.string()),
    fail_fast: z.boolean().optional(),
  })
  .refine((s) => Boolean(s.over) !== Boolean(s.data_selector), {
    message:
      "Loop step must set exactly one of `over` (path/JSONata) or `data_selector` (JS expression).",
    path: ["over"],
  })
  .openapi("LoopStep");

export const StepSchema = z.discriminatedUnion("kind", [
  RequestStepSchema,
  TransformStepSchema,
  CallStepSchema,
  WaitStepSchema,
  WaitForEventStepSchema,
  BranchStepSchema,
  ParallelStepSchema,
  LoopStepSchema,
]);

export const WorkflowRuntimeSchema = z
  .object({
    stdlib_version: z.string().optional(),
  })
  .openapi("WorkflowRuntime");

export const RequestTriggerSchema = z
  .object({
    kind: z.literal("request"),
  })
  .openapi("RequestTrigger");

export const WebhookTriggerSchema = z
  .object({
    kind: z.literal("webhook"),
    source: z.string().min(1),
    events: z.array(z.string().min(1)),
    verify: z.enum(["stripe-signature", "github-hmac", "none"]),
  })
  .openapi("WebhookTrigger");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ScheduleTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    cron: z.string().min(1),
    tz: z.string().min(1).default("UTC"),
    execution_mode: z.enum(["dev", "prod"]).optional(),
    business_days_only: z.boolean().optional(),
    skip_dates: z
      .array(z.string().regex(ISO_DATE_RE, "skip_dates entries must be ISO YYYY-MM-DD"))
      .optional(),
  })
  .openapi("ScheduleTrigger");

export const TriggerSchema = z
  .discriminatedUnion("kind", [RequestTriggerSchema, WebhookTriggerSchema, ScheduleTriggerSchema])
  .openapi("WorkflowTrigger");

export type RequestTrigger = z.infer<typeof RequestTriggerSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
export type WorkflowTrigger = z.infer<typeof TriggerSchema>;

const _baseWorkflowDefSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional(),
  tool_effect: z.enum(["read", "reversible_write", "irreversible_write"]).optional(),
  derived_from_skill_id: z.string().nullable().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  input_schema_sample: z.unknown().optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
  validation_expression: z.string().min(1).optional(),
  validation_function: z.string().min(1).optional(),
  output_transform: z.string().min(1).optional(),
  output_transform_function: z.string().min(1).optional(),
  response_filters: z.array(ResponseFilterSchema).optional(),
  steps: z.array(StepSchema).min(1).max(200),
  timeout_ms: z.number().int().positive().optional(),
  max_llm_tokens_per_run: z.number().int().positive().optional(),
  runtime: WorkflowRuntimeSchema.optional(),
  trigger: TriggerSchema.optional(),
});

const WORKFLOW_TIMEOUT_DEFAULT_MS_LITERAL = 6 * 60 * 60_000;

export const WorkflowDefSchema = _baseWorkflowDefSchema
  .superRefine((s, ctx) => {
    if (s.output_transform && s.output_transform_function) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output_transform_function"],
        message:
          "set either `output_transform` (JSONata) or `output_transform_function` (JS), not both",
      });
    }
    if (s.validation_expression && s.validation_function) {
    }
    const workflowTimeoutMs = s.timeout_ms ?? WORKFLOW_TIMEOUT_DEFAULT_MS_LITERAL;
    s.steps.forEach((step, idx) => {
      if (step.kind !== "wait_for_event") return;
      if (step.timeout_ms > workflowTimeoutMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", idx, "timeout_ms"],
          message: `wait_for_event.timeout_ms (${step.timeout_ms}ms) exceeds WorkflowDef.timeout_ms (${workflowTimeoutMs}ms). Set workflow.timeout_ms ≥ ${step.timeout_ms} so the workflow does not abort the wait early.`,
        });
      }
    });
  })
  .openapi("WorkflowDef");

export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

export const WORKFLOW_DEF_FIELD_KEYS = Object.keys(_baseWorkflowDefSchema.shape) as Array<
  keyof WorkflowDef
>;

export type StepDef = z.infer<typeof StepSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type TransformStep = z.infer<typeof TransformStepSchema>;
export type CallStep = z.infer<typeof CallStepSchema>;
export type WaitStep = z.infer<typeof WaitStepSchema>;
export type WaitForEventStep = z.infer<typeof WaitForEventStepSchema>;
export type BranchStep = z.infer<typeof BranchStepSchema>;
export type ParallelStep = z.infer<typeof ParallelStepSchema>;
export type LoopStep = z.infer<typeof LoopStepSchema>;
export type ResponseFilter = z.infer<typeof ResponseFilterSchema>;
