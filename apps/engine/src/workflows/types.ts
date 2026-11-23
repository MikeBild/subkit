import { z } from "@hono/zod-openapi";
import { FileRefSchema } from "../api/files-schemas.ts";
import { isSafeRegex, SAFE_REGEX_REMEDY } from "../utils/safe-regex.ts";
import { WORKFLOW_MAX_STEPS } from "./core/definition.ts";
import type { JsonValue } from "./domain-types.ts";
import { McpBoundaryScopeSchema } from "./mcp-boundary.ts";
import { OutboxDeliveryBoundarySchema } from "./outbox-delivery-boundary.ts";
import { ReportDeliveryBoundarySchema } from "./report-delivery-boundary.ts";
import { RequestBoundaryScopeSchema } from "./request-boundary.ts";
import { StorageScopeSchema } from "./storage-boundary.ts";
import { TransactionalDeliveryBoundarySchema } from "./transactional-delivery-boundary.ts";
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
    pattern: z.string().refine(isSafeRegex, { message: `regex_unsafe: ${SAFE_REGEX_REMEDY}` }),
    mask: z.string().optional(),
    scope: z.enum(["FIELD", "ITEM", "ENTRY"]).optional(),
  })
  .openapi("ResponseFilter");

const paginationLimits = {
  max_items: z.number().int().positive().max(1_000_000).optional(),
  on_limit: z.enum(["fail", "truncate"]).optional(),
  unique_by: z.string().min(1).max(200).optional(),
  stop_when: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe(
      "JavaScript arrow `(page, info) => boolean`, evaluated after each page; `info` has `page` (1-based), `pages` and `items`. Returning true ends the pagination as complete.",
    ),
};

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
      ...paginationLimits,
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
      ...paginationLimits,
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
      ...paginationLimits,
    }),
    z
      .object({
        strategy: z.literal("link"),
        link_params: z.array(z.string().min(1).max(64)).min(1).max(3),
        page_size: z.number().int().positive().max(100_000).optional(),
        limit_param: z.string().min(1).optional(),
        items_path: z.string().optional(),
        output_mode: z.enum(["items", "pages"]).optional(),
        max_pages: z.number().int().positive().max(1000).optional(),
        ...paginationLimits,
      })
      .strict()
      .refine((spec) => spec.limit_param === undefined || spec.page_size !== undefined, {
        message: "link pagination with limit_param needs page_size",
        path: ["page_size"],
      })
      .refine((spec) => !spec.limit_param || !spec.link_params.includes(spec.limit_param), {
        message: "limit_param must not be one of link_params",
        path: ["limit_param"],
      }),
  ])
  .superRefine((spec, ctx) => {
    if (spec.output_mode !== "pages") return;
    for (const key of ["max_items", "unique_by"] as const)
      if (spec[key] !== undefined)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} counts items and cannot be combined with output_mode "pages"`,
        });
  })
  .openapi("Pagination");

const onError = z.enum(["fail", "continue"]).default("fail");

const errorPolicy = z.enum(["none", "all"]).default("none");

type GraphQLConfig = {
  operation?: "query" | "mutation" | "subscription" | undefined;
  query: string;
  variables?: Record<string, unknown> | undefined;
  cursor_pagination?:
    | {
        connection_path: string;
        cursor_variable: string;
        items_field: "nodes" | "edges";
        required_connection_paths?: string[] | undefined;
        max_pages: number;
        max_items: number;
        expected_items?: { min?: number | undefined; max?: number | undefined } | undefined;
        reread_on_empty?: number | undefined;
      }
    | undefined;
};

const GraphQLConfigSchema: z.ZodType<GraphQLConfig> = z
  .object({
    operation: z.enum(["query", "mutation", "subscription"]).optional(),
    query: z.string().min(1),
    variables: z.record(z.string(), z.unknown()).optional(),
    cursor_pagination: z
      .object({
        connection_path: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/),
        cursor_variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        items_field: z.enum(["nodes", "edges"]).default("nodes"),
        required_connection_paths: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/))
          .max(16)
          .optional(),
        max_pages: z.number().int().min(1).max(100),
        max_items: z.number().int().min(1).max(10_000),
        expected_items: z
          .object({
            min: z.number().int().min(0).optional(),
            max: z.number().int().min(0).optional(),
          })
          .superRefine((bounds, zctx) => {
            if (bounds.min === undefined && bounds.max === undefined) {
              zctx.addIssue({
                code: "custom",
                message: "expected_items object must set at least one of `min` or `max`",
              });
            } else if (
              bounds.min !== undefined &&
              bounds.max !== undefined &&
              bounds.min > bounds.max
            ) {
              zctx.addIssue({
                code: "custom",
                message: `expected_items { min: ${bounds.min}, max: ${bounds.max} } has min > max (unsatisfiable)`,
              });
            }
          })
          .optional(),
        reread_on_empty: z.number().int().min(0).max(3).optional(),
      })
      .optional(),
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
    file: z
      .union([FileRefSchema, z.string().regex(/^\$\{(?:input|scope|item)\.[A-Za-z0-9_.-]+\}$/)])
      .optional(),
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
  id: z
    .string()
    .min(1)
    .refine((id) => !id.startsWith("$"), "step id is reserved"),
  on_error: onError.optional(),
  data_selector: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
  for_each: z.string().optional(),
  for_each_concurrency: z.number().int().min(1).optional(),
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const S3_METHODS = ["GET", "PUT", "HEAD", "DELETE", "LIST"] as const;
const SFTP_METHODS = ["LIST", "GET", "PUT", "DELETE"] as const;
const SQL_METHODS = ["GET", "SELECT", "INSERT", "UPDATE", "DELETE", "CALL"] as const;
const MCP_METHODS = [
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
] as const;

const XmlBodySchema = z.object({
  body: JsonValueSchema,
  declaration: z.boolean().optional(),
});

const SqlBlockSchema = z.object({
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
});

const S3BlockSchema = z.object({
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
});

const SftpBlockSchema = z.object({
  path: z.string().min(1).openapi({
    description:
      "Remote path below the connector's root folder. LIST reads a folder; GET, PUT and DELETE address one file. Placeholders are filled in before the call.",
  }),
  max_entries: z.number().int().positive().max(10_000).optional().openapi({
    description: "Upper bound for the entries a LIST returns.",
  }),
});

const McpBlockSchema = z
  .object({
    operation: z.enum(["call_tool", "read_resource", "get_prompt"]).default("call_tool"),
    tool: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    arguments: z.record(z.string(), JsonValueSchema).optional(),
    boundary: McpBoundaryScopeSchema.optional(),
  })
  .superRefine((m, ctx) => {
    if (m.boundary !== undefined && m.operation !== "call_tool") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundary"],
        message: "mcp.boundary bounds a tool call; it is only accepted with operation call_tool",
      });
    }
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
  });

type RequestBlock = "graphql" | "sql" | "s3" | "sftp" | "mcp";

function foreignBlock(block: RequestBlock) {
  return z
    .never({
      error: `the \`${block}\` block needs \`protocol: "${block}"\` on the step — a step speaks exactly one protocol`,
    })
    .openapi({ type: "null", not: {} })
    .optional();
}

function httpOnlyXml(protocol: RequestBlock) {
  return z
    .never({
      error: `\`xml\` is an HTTP body encoding and is not accepted on a step with \`protocol: "${protocol}"\``,
    })
    .openapi({ type: "null", not: {} })
    .optional();
}

const requestStepBase = {
  side_effects: z.enum(["read", "write"]).optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  connector_id: z.string().uuid().optional(),
  boundary: RequestBoundaryScopeSchema.optional(),
  report_delivery: ReportDeliveryBoundarySchema.optional(),
  transactional_delivery: TransactionalDeliveryBoundarySchema.optional(),
  outbox_delivery: OutboxDeliveryBoundarySchema.optional(),
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
  error_policy: errorPolicy.optional(),
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
};

interface RowCountChecked {
  expected_row_count?: unknown;
}

function checkRowCountExpectation(
  val: unknown,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (Array.isArray(val) && val.length === 2) {
    const [lo, hi] = val as [number, number];
    if (lo > hi) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `expected_row_count tuple [${lo}, ${hi}] has lo > hi (unsatisfiable)`,
      });
    }
  } else if (val && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as { min?: number; max?: number };
    if (obj.min !== undefined && obj.max !== undefined && obj.min > obj.max) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `expected_row_count { min: ${obj.min}, max: ${obj.max} } has min > max (unsatisfiable)`,
      });
    }
  }
}

function checkAddressed(
  s: { url?: string | undefined; connector_id?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (s.url !== undefined || s.connector_id !== undefined) return;
  ctx.addIssue({
    code: "custom",
    message:
      'request step must specify either url or connector_id (a postgres step with `protocol: "sql"` is addressed by its sql block)',
  });
}

function checkReadOverride(
  s: { side_effects?: "read" | "write" | undefined; method: string },
  ctx: z.RefinementCtx,
): void {
  if (s.side_effects !== "read" || !["PUT", "PATCH", "DELETE"].includes(s.method)) return;
  ctx.addIssue({
    code: "custom",
    path: ["side_effects"],
    message: `side_effects:"read" cannot downgrade mutating method ${s.method}`,
  });
}

function rejectRowCount(s: RowCountChecked, ctx: z.RefinementCtx, message: string): void {
  if (s.expected_row_count === undefined) return;
  ctx.addIssue({ code: "custom", path: ["expected_row_count"], message });
}

export const HttpRequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("http").optional(),
    ...baseStep,
    method: z.enum(HTTP_METHODS).optional().default("GET"),
    ...requestStepBase,
    xml: XmlBodySchema.optional(),
    graphql: foreignBlock("graphql"),
    sql: foreignBlock("sql"),
    s3: foreignBlock("s3"),
    sftp: foreignBlock("sftp"),
    mcp: foreignBlock("mcp"),
  })
  .superRefine((s, ctx) => {
    checkAddressed(s, ctx);
    checkReadOverride(s, ctx);
    rejectRowCount(s, ctx, "expected_row_count is postgres-only; HTTP steps use expected_statuses");
  })
  .openapi("HttpRequestStep");

export const GraphqlRequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("graphql"),
    ...baseStep,
    method: z.enum(HTTP_METHODS).optional().default("GET"),
    ...requestStepBase,
    graphql: GraphQLConfigSchema,
    xml: httpOnlyXml("graphql"),
    sql: foreignBlock("sql"),
    s3: foreignBlock("s3"),
    sftp: foreignBlock("sftp"),
    mcp: foreignBlock("mcp"),
  })
  .superRefine((s, ctx) => {
    checkAddressed(s, ctx);
    checkRowCountExpectation(s.expected_row_count, ["expected_row_count"], ctx);
  })
  .openapi("GraphqlRequestStep");

export const SqlRequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("sql"),
    ...baseStep,
    method: z.enum(SQL_METHODS).optional().default("GET"),
    ...requestStepBase,
    sql: SqlBlockSchema,
    xml: httpOnlyXml("sql"),
    graphql: foreignBlock("graphql"),
    s3: foreignBlock("s3"),
    sftp: foreignBlock("sftp"),
    mcp: foreignBlock("mcp"),
  })
  .superRefine((s, ctx) => {
    checkRowCountExpectation(s.expected_row_count, ["expected_row_count"], ctx);
    s.sql.also?.forEach((stmt, idx) => {
      checkRowCountExpectation(
        stmt.expected_row_count,
        ["sql", "also", idx, "expected_row_count"],
        ctx,
      );
    });
    if (s.expected_statuses !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expected_statuses"],
        message: "expected_statuses is HTTP/S3 only; postgres steps use expected_row_count",
      });
    }
    if (s.sql.transaction === false && s.sql.also && s.sql.also.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sql", "transaction"],
        message: "sql.transaction cannot be false when sql.also is set",
      });
    }
    if (s.sql.cursor !== undefined && s.sql.also !== undefined && s.sql.also.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["sql", "cursor"],
        message:
          "sql.cursor cannot be combined with sql.also (the cursor opens its own transaction)",
      });
    }
  })
  .openapi("SqlRequestStep");

export const S3RequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("s3"),
    ...baseStep,
    method: z.enum(S3_METHODS).optional().default("GET"),
    ...requestStepBase,
    s3: S3BlockSchema,
    xml: httpOnlyXml("s3"),
    graphql: foreignBlock("graphql"),
    sql: foreignBlock("sql"),
    sftp: foreignBlock("sftp"),
    mcp: foreignBlock("mcp"),
  })
  .superRefine((s, ctx) => {
    checkAddressed(s, ctx);
    checkReadOverride(s, ctx);
    rejectRowCount(s, ctx, "expected_row_count is postgres-only; s3 steps use expected_statuses");
    if (s.method === "LIST" && !s.s3.prefix) {
      ctx.addIssue({
        code: "custom",
        path: ["s3", "prefix"],
        message: "s3 LIST requires a prefix",
      });
    }
    if (s.method !== "LIST" && !s.s3.key && !s.path) {
      ctx.addIssue({
        code: "custom",
        path: ["s3", "key"],
        message: `s3 ${s.method} requires either s3.key or step.path`,
      });
    }
  })
  .openapi("S3RequestStep");

export const SftpRequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("sftp"),
    ...baseStep,
    method: z.enum(SFTP_METHODS).optional().default("GET"),
    ...requestStepBase,
    sftp: SftpBlockSchema,
    xml: httpOnlyXml("sftp"),
    graphql: foreignBlock("graphql"),
    sql: foreignBlock("sql"),
    s3: foreignBlock("s3"),
    mcp: foreignBlock("mcp"),
  })
  .superRefine((s, ctx) => {
    checkReadOverride(s, ctx);
    rejectRowCount(s, ctx, "expected_row_count is postgres-only; an sftp step moves files");
    if (s.connector_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["connector_id"],
        message:
          "sftp step requires connector_id — the server and its host key live on the connector",
      });
    }
    if (s.url !== undefined || s.path !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["sftp", "path"],
        message: "an sftp step addresses its file with sftp.path, not url or path",
      });
    }
  })
  .openapi("SftpRequestStep");

export const McpRequestStepSchema = z
  .object({
    kind: z.literal("request"),
    protocol: z.literal("mcp"),
    ...baseStep,
    method: z.enum(MCP_METHODS).optional().default("GET"),
    ...requestStepBase,
    mcp: McpBlockSchema,
    xml: httpOnlyXml("mcp"),
    graphql: foreignBlock("graphql"),
    sql: foreignBlock("sql"),
    s3: foreignBlock("s3"),
    sftp: foreignBlock("sftp"),
  })
  .superRefine((s, ctx) => {
    if (s.connector_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["connector_id"],
        message: "mcp step requires connector_id — an MCP server is addressed as a connector",
      });
    }
    if (s.expected_statuses !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expected_statuses"],
        message: "expected_statuses is HTTP/S3 only; an MCP call has no HTTP status",
      });
    }
    rejectRowCount(
      s,
      ctx,
      "expected_row_count is postgres-only; an MCP call returns content, not rows",
    );
    if (s.timeout_ms !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["timeout_ms"],
        message:
          "timeout_ms does not bound an mcp step; the deadline for a remote call is the connector's `config.mcp.remote_tool_call_timeout_ms` (tenant default: `connectors.mcp.remote_tool_call_timeout_ms`, ceiling 300000ms)",
      });
    }
  })
  .openapi("McpRequestStep");

export const RequestStepSchema = z
  .discriminatedUnion("protocol", [
    HttpRequestStepSchema,
    GraphqlRequestStepSchema,
    SqlRequestStepSchema,
    S3RequestStepSchema,
    SftpRequestStepSchema,
    McpRequestStepSchema,
  ])
  .openapi("RequestStep", {
    discriminator: {
      propertyName: "protocol",
      mapping: {
        http: "#/components/schemas/HttpRequestStep",
        graphql: "#/components/schemas/GraphqlRequestStep",
        sql: "#/components/schemas/SqlRequestStep",
        s3: "#/components/schemas/S3RequestStep",
        sftp: "#/components/schemas/SftpRequestStep",
        mcp: "#/components/schemas/McpRequestStep",
      },
    },
  });

export const PARSE_FILE_FORMATS = ["csv", "xlsx", "pdf", "docx", "zip"] as const;
export const PARSE_FILE_MAX_ROWS = 10_000;

export const ParseFileConfigSchema = z
  .object({
    source: z.string().min(1).openapi({
      description:
        "Where the file sits in the run, as a dot path: an earlier step's output such as `download.data` or a run input such as `$input.invoice`. The value must be a file reference (`{ $file }`) or a file result of a request step.",
    }),
    format: z.enum(PARSE_FILE_FORMATS).optional().openapi({
      description: "File type. Without it the type is read from the file itself.",
    }),
    sheet: z.string().min(1).optional().openapi({
      description: "Spreadsheet sheet to read. Without it the first sheet is read.",
    }),
    max_rows: z.number().int().min(1).max(PARSE_FILE_MAX_ROWS).optional().openapi({
      description: "Upper bound for table rows returned from a CSV or spreadsheet file.",
    }),
  })
  .openapi("ParseFileConfig");

export const TransformStepSchema = z
  .object({
    kind: z.literal("transform"),
    ...baseStep,
    expression: z.string().optional(),
    language: z
      .enum(["javascript", "readability", "html-to-markdown", "structured-data", "parse-file"])
      .optional(),
    readability: ReadabilityConfigSchema.optional(),
    markdown: MarkdownConfigSchema.optional(),
    structured_data: StructuredDataConfigSchema.optional(),
    file: ParseFileConfigSchema.optional(),
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
    if (language === "parse-file" && s.expression !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expression"],
        message:
          "transform.language=parse-file does not accept an expression; configure via the `file` block",
      });
    }
    if (language === "parse-file" && s.file === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: "transform.language=parse-file requires a `file` block with a `source`",
      });
    }
    if (s.file !== undefined && language !== "parse-file") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: 'file config is only valid when language="parse-file"',
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

export const MODEL_STEP_MAX_OUTPUT_TOKENS = 32_000;

export const ModelStepSchema = z
  .object({
    kind: z.literal("model"),
    ...baseStep,
    prompt: z.string().min(1).openapi({
      description:
        "The instruction for the model. Placeholders such as ${input.x} or ${scope.step.data} are filled in before the call.",
    }),
    system: z.string().min(1).optional().openapi({
      description: "Optional system prompt. Without it the step uses a short neutral default.",
    }),
    input: JsonValueSchema.optional().openapi({
      description:
        "Data handed to the model next to the prompt, as data and never as instructions.",
    }),
    output_schema: z.record(z.string(), z.unknown()).openapi({
      description: "JSON Schema the model's answer must match. The step fails when it does not.",
    }),
    max_output_tokens: z.number().int().min(1).max(MODEL_STEP_MAX_OUTPUT_TOKENS).optional(),
  })
  .openapi("ModelStep");

export const StepSchema = z.discriminatedUnion("kind", [
  RequestStepSchema,
  TransformStepSchema,
  CallStepSchema,
  WaitStepSchema,
  WaitForEventStepSchema,
  BranchStepSchema,
  ParallelStepSchema,
  ModelStepSchema,
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

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const INPUT_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export const CallerDailyLimitSchema = z
  .object({
    bucket: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .describe("Ledger bucket shared by workflows that draw from the same daily allowance"),
    limit: z.number().int().min(1).max(10_000).describe("Units per caller and local day"),
    tz: z
      .string()
      .min(1)
      .refine(isIanaTimeZone, "tz must be an IANA time zone")
      .describe("Time zone whose midnight resets the daily allowance"),
    unit: z
      .string()
      .regex(INPUT_PATH)
      .describe(
        "Dot path into $input whose value (1..128 characters) is the unit one charge covers",
      ),
    lease_ms: z
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(600_000)
      .describe("How long a reserved unit waits for its next round before it settles"),
    billable_steps: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Step ids whose sent requests or success make the unit billable; a sent request is never refunded",
      ),
    meter: z
      .string()
      .min(1)
      .optional()
      .describe(
        "JSONata over a billable step output yielding the calls it used (default 1); requests already sent count toward it",
      ),
    max_metered: z
      .number()
      .int()
      .min(1)
      .describe(
        "Metered calls a unit may use before admission refuses with turn_limit; later calls of a reserved or committed unit are free and one call of a unit runs at a time",
      ),
    commit_when: z
      .string()
      .min(1)
      .describe(
        "JSONata over the run output; true commits the unit so it is never refunded, false keeps it reserved",
      ),
    attach_usage_as: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .default("usage")
      .describe("Result key that receives {usedToday, dailyLimit} after settlement"),
  })
  .strict()
  .openapi("CallerDailyLimit");

export const InputByteLimitsSchema = z
  .record(
    z.string().regex(INPUT_PATH),
    z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
  )
  .describe(
    "Maximum UTF-8 bytes per $input path (a string counts itself, other values their JSON text); checked at admission before any charge",
  );

export const ExecutionGuardsSchema = z
  .object({
    caller_daily_limit: CallerDailyLimitSchema.optional(),
    input_bytes: InputByteLimitsSchema.optional(),
  })
  .strict()
  .openapi("ExecutionGuards");

export type CallerDailyLimit = z.infer<typeof CallerDailyLimitSchema>;
export type ExecutionGuards = z.infer<typeof ExecutionGuardsSchema>;

const _baseWorkflowDefSchema = z.object({
  name: z.string().min(1),
  product_id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  required_caller_kind: z.enum(["user", "system_account"]).optional(),
  execution_privacy: z.literal("sensitive").optional(),
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
  steps: z.array(StepSchema).min(1).max(WORKFLOW_MAX_STEPS),
  timeout_ms: z.number().int().positive().optional(),
  device_offline: z.enum(["wait", "fail"]).optional(),
  max_llm_tokens_per_run: z.number().int().positive().optional().openapi({
    description: "cap for all model steps and provider calls in one run",
  }),
  runtime: WorkflowRuntimeSchema.optional(),
  trigger: TriggerSchema.optional(),
  execution_guards: ExecutionGuardsSchema.optional(),
  caller_erasure: z.literal("on_success").optional(),
});

const WORKFLOW_TIMEOUT_DEFAULT_MS_LITERAL = 6 * 60 * 60_000;

export const WorkflowDefSchema = _baseWorkflowDefSchema
  .superRefine((s, ctx) => {
    if (s.product_id) {
      s.steps.forEach((step, idx) => {
        if (
          step.kind === "request" &&
          step.s3 &&
          (!step.s3.scope?.principal_bound ||
            step.s3.scope.key_prefix !== `products/${s.product_id}/`)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", idx, "s3", "scope"],
            message: "product S3 steps require a caller-bound product folder",
          });
        }
      });
    }
    const dailyLimit = s.execution_guards?.caller_daily_limit;
    if (dailyLimit || s.caller_erasure) {
      if (!s.product_id || s.required_caller_kind !== "user") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [dailyLimit ? "execution_guards" : "caller_erasure"],
          message:
            "caller guards and caller erasure require product_id and required_caller_kind user",
        });
      }
      if (s.execution_privacy !== "sensitive") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [dailyLimit ? "execution_guards" : "caller_erasure"],
          message: "caller guards and caller erasure require execution_privacy sensitive",
        });
      }
    }
    if (dailyLimit) {
      const stepIds = new Set(s.steps.map((step) => step.id));
      dailyLimit.billable_steps.forEach((id, idx) => {
        if (!stepIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["execution_guards", "caller_daily_limit", "billable_steps", idx],
            message: `billable step "${id}" is not a step of this workflow`,
          });
        }
      });
    }
    if (s.output_transform && s.output_transform_function) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output_transform_function"],
        message:
          "set either `output_transform` (JSONata) or `output_transform_function` (JS), not both",
      });
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

export const WorkflowDraftDefSchema = _baseWorkflowDefSchema
  .extend({ steps: z.array(StepSchema).max(WORKFLOW_MAX_STEPS) })
  .openapi("WorkflowDraftDef");

export type WorkflowDraftDef = z.infer<typeof WorkflowDraftDefSchema>;

export const WORKFLOW_DEF_FIELD_KEYS = Object.keys(_baseWorkflowDefSchema.shape) as Array<
  keyof WorkflowDef
>;

export type StepDef = z.infer<typeof StepSchema>;
export type RequestStep = z.infer<typeof RequestStepSchema>;
export type TransformStep = z.infer<typeof TransformStepSchema>;
export type ModelStep = z.infer<typeof ModelStepSchema>;
export type CallStep = z.infer<typeof CallStepSchema>;
export type WaitStep = z.infer<typeof WaitStepSchema>;
export type WaitForEventStep = z.infer<typeof WaitForEventStepSchema>;
export type BranchStep = z.infer<typeof BranchStepSchema>;
export type ParallelStep = z.infer<typeof ParallelStepSchema>;
export type ResponseFilter = z.infer<typeof ResponseFilterSchema>;
