// Workflow definition zod schemas. The shape is the user-authored DAG that
// gets persisted into `workflow_versions.dag` and consumed by the execution
// engine. The core step kinds are: request, transform, call, wait,
// wait_for_event, branch, parallel, loop.

import { z } from "@hono/zod-openapi";
import { FileRefSchema } from "../api/files-schemas.ts";
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
// Re-export the three web-scraper envelope schemas so existing
// `import … from "./workflows/types.ts"` call sites keep working. The
// definitions live in `./types-web-scraper.ts` to keep this file under
// the 1000-LOC audit ceiling.
export {
  MarkdownOutputSchema,
  ReadabilityOutputSchema,
  StructuredDataOutputSchema,
} from "./types-web-scraper.ts";

// Helpers `parseHeaderLines`, `HTTP_TOKEN_RE`, and
// `looksLikeJsonObjectOrArray` live in `./types-helpers.ts` so this
// file stays under the 1000-LOC audit ceiling.

// JSON value — extended to accept `{ "$file": "fid_..." }` reference leaves.
// The union is additive: existing workflow JSON (plain objects, arrays, scalars)
// parses unchanged; the new FileRef variant is simply an additional leaf type.
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
        // Reject the LLM's frequent failure mode: a JSON-encoded
        // object string `'{"query":"{ users { id } }"}'` instead of
        // the unwrapped GraphQL document. A real GraphQL document
        // also starts with `{`, so we only fail when the entire
        // string parses as JSON. (Audit anti-pattern B1, conversation
        // 730c568a.)
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

// `looksLikeJsonObjectOrArray` moved to `./types-helpers.ts`.

/**
 * A single part in a multipart/form-data upload. Either `file` (resolved
 * from a `$file` reference by the step-runner) or `value` (plain text
 * field) must be present — both may not be absent simultaneously.
 */
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

/**
 * Typed `file` leaf for `input_schema`. Lets operators declare that a
 * workflow input accepts a file reference (`{ "$file": "fid_..." }`).
 * The step-runner resolves `$file` refs eagerly at the step boundary.
 */
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
  /**
   * Inline iteration — JS selector body that replaces the `loop` step
   * kind for simple fan-out. The expression receives `sourceData` (the
   * full execution scope) and must return an array. The step runs once
   * per element; each iteration binds `$item` (the current element) and
   * `$loop_index` (0-based counter) into the substitution scope.
   *
   * Example:
   *   for_each: "(sourceData) => sourceData.fetch_projects.data"
   *
   * This field is distinct from `LoopStep.data_selector` (which is a
   * per-loop-step source selector run via runJs on the LOOP step itself,
   * NOT on baseStep). `for_each` lives on baseStep so any step kind can
   * declare inline iteration without a surrounding loop wrapper.
   *
   * Returns an array; semantics identical to LoopStep.data_selector's
   * runJs path. Never shadows the output-projector `data_selector`
   * (JSONPath-lite, handled by applySelector in step-runner.ts).
   */
  for_each: z.string().optional(),
  /**
   * Bounded parallelism for `for_each` iterations. When set (>= 1), at
   * most this many iterations run concurrently; iteration result order
   * is preserved regardless. When unset, the engine auto-selects from
   * the step's side-effect class: a READ-classified `request` body
   * (HTTP GET/HEAD/OPTIONS, GraphQL query, SQL SELECT-only, S3
   * GET/HEAD/LIST, or an explicit `side_effects: "read"`) fans out at
   * the default bound; write-classified requests and non-request bodies
   * (transform/…) stay sequential. An explicit value always wins — set
   * `1` to force sequential, or a higher bound to parallelize a
   * write fan-out the author knows is safe (e.g. independent POSTs).
   */
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
        // S3 driver — `LIST` is informational at the step level;
        // prefer the structured `s3` block to express intent.
        "LIST",
        // Postgres driver — informational SQL verbs. Prefer the
        // structured `sql` block; the driver decides return shape
        // from the query, not the method.
        "SELECT",
        "INSERT",
        "UPDATE",
        "CALL",
      ])
      .optional()
      .default("GET"),
    /**
     * Side-effect classification override for hold-writes previews
     * (Fix G). When unset the driver classifies at dispatch time:
     * HTTP GET/HEAD/OPTIONS = read, other methods = write (RFC
     * semantics, the same `isIdempotent` seam the retry policy uses);
     * GraphQL `query` = read, `mutation`/`subscription` = write;
     * SQL SELECT-only = read, anything else = write; S3 GET/HEAD/LIST
     * = read. Set `"read"` for a POST that is semantically a search,
     * or `"write"` to force-hold a GET that mutates server state. PUT,
     * PATCH, DELETE, S3 mutations, SQL writes, GraphQL mutations and
     * remote MCP tool calls cannot be downgraded to reads.
     */
    side_effects: z.enum(["read", "write"]).optional(),
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
    // Apollo errorPolicy convention. "none" (default = legacy): a GraphQL response
    // carrying body.errors fails the step. "all": accept data-with-errors — step
    // succeeds, errors surface as partial-result meta + a warn log. Applies only to
    // the graphql branch.
    error_policy: errorPolicy.optional(),
    /**
     * Optional SQL operation. When present, the request step routes
     * through the postgres driver. `query` is a parameterised SQL
     * statement (use `$1`, `$2` placeholders); `params` is the bound
     * argument list. Method on the step is informational ("SELECT",
     * "INSERT", "UPDATE", "DELETE", "CALL"); the driver decides
     * whether to return rows or affected counts based on the query
     * shape.
     */
    /**
     * Optional XML request body. Symmetric to the response parser —
     * the same tree shape (`@attr` keys, `#text`, repeated children
     * as arrays) round-trips back into well-formed XML. Sets the
     * `Content-Type: application/xml` header automatically unless one
     * was set explicitly.
     */
    xml: z
      .object({
        body: JsonValueSchema,
        /** Add the XML declaration `<?xml version="1.0" …?>` prologue. */
        declaration: z.boolean().optional(),
      })
      .optional(),
    sql: z
      .object({
        query: z.string().min(1),
        params: z.array(z.unknown()).optional(),
        /** Wrap the statement (and any subsequent statements in the
         *  `also` array) in a single transaction. When `also` is set
         *  the driver opens a connection, BEGIN, runs every statement
         *  in order, COMMIT (or ROLLBACK on first failure), then
         *  releases the connection. */
        also: z
          .array(
            z.object({
              query: z.string().min(1),
              params: z.array(z.unknown()).optional(),
              /** Per-statement row-count assertion. Same shape as
               *  step.expected_row_count. Mismatch rolls back the
               *  whole transaction with `expected_row_count_mismatch`. */
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
        /** Stream rows via a server-side cursor instead of buffering
         *  the full result set. `fetch_size` controls the per-batch
         *  size; the step output is still a single concatenated array
         *  (caller-visible scope contract is unchanged), but memory
         *  pressure stays bounded. */
        cursor: z
          .object({
            fetch_size: z.number().int().positive().max(10_000).default(1000),
          })
          .optional(),
      })
      .optional(),
    /**
     * Optional S3 operation. When present, the request step routes
     * through the S3 driver. Richer fields than the bare HTTP path:
     * `key` is the object key (with `${input.…}` substitution),
     * `prefix` for LIST operations, `parse_as` controls the response
     * decode ("json" | "text" | "base64" | "bytes"), `max_keys` +
     * `paginate` cover LIST pagination, `content_type` + `metadata` +
     * `multipart_threshold_mb` ride on PUT, `range` on GET, and
     * `presign` on GET/PUT to mint a presigned URL instead of
     * executing.
     */
    s3: z
      .object({
        scope: StorageScopeSchema.optional(),
        key: z.string().optional(),
        prefix: z.string().optional(),
        parse_as: z.enum(["json", "text", "base64", "bytes"]).optional(),
        max_keys: z.number().int().positive().max(10_000).optional(),
        content_type: z.string().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        /** Continue across continuation tokens until `max_keys` items
         *  are collected (or the bucket is exhausted). When false, the
         *  driver returns at most one page (default behaviour). */
        paginate: z.boolean().optional(),
        /** Force / disable multipart upload. When set, overrides the
         *  driver's automatic threshold. */
        multipart: z.boolean().optional(),
        /** Override the per-PUT multipart threshold in MiB. Default 8. */
        multipart_threshold_mb: z.number().positive().max(1024).optional(),
        /** RFC 7233 byte-range expression for partial GETs (e.g.
         *  "bytes=0-1023"). The driver forwards it as a Range header. */
        range: z.string().optional(),
        /** Generate a presigned URL instead of executing the
         *  operation. Returns `{ url, method, expires_at }` as the
         *  step output. Supported for GET / PUT. */
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
    /**
     * Optional MCP operation. When present, the request step routes
     * through the MCP driver — a remote Model Context Protocol server
     * addressed as a connector.
     *
     * A SUB-BLOCK, not a step kind: `graphql`, `sql` and `s3` already
     * established that a driver is a shape inside `request`, not a new
     * member of the step union, and everything a request step gives an
     * author (retry, backoff, `error_policy`, `response_filters`,
     * `for_each`, the versioned output envelope) comes for free that way.
     *
     * Three operations, matching the three things an MCP server exposes:
     *   - `call_tool`    → `tools/call`     (needs `tool`, takes `arguments`)
     *   - `read_resource`→ `resources/read` (needs `uri`)
     *   - `get_prompt`   → `prompts/get`    (needs `prompt`, takes `arguments`)
     *
     * SIDE EFFECTS: `call_tool` is classified WRITE and therefore passes
     * through the same hold-writes / approval gate as a POST — see
     * `SideEffectInput.mcp` in packages/shared/src/side-effects.ts for
     * why neither the remote's own `readOnlyHint` nor an author-generated
     * `side_effects: "read"` grants permission to dispatch a tool call.
     */
    mcp: z
      .object({
        operation: z.enum(["call_tool", "read_resource", "get_prompt"]).default("call_tool"),
        /** Remote tool name for `call_tool`. The UNPREFIXED name as the
         *  server publishes it — the `mcp_<slug>__<tool>` palette name is
         *  a model-facing address, not a workflow one. */
        tool: z.string().min(1).optional(),
        /** Resource URI for `read_resource`, verbatim as the server
         *  published it (`file://`, `https://`, or any custom scheme). */
        uri: z.string().min(1).optional(),
        /** Prompt name for `get_prompt`. */
        prompt: z.string().min(1).optional(),
        /** Arguments for `call_tool` / `get_prompt`. Placeholders resolve
         *  type-preservingly, like `graphql.variables` — a whole-value
         *  `"${input.limit}"` stays a number. */
        arguments: z.record(z.string(), JsonValueSchema).optional(),
      })
      .superRefine((m, ctx) => {
        // Each operation names its target in a different field, and a step
        // that sets the wrong one would otherwise fail at dispatch with
        // "tool is required" against a step that clearly meant to read a
        // resource. Naming the field here costs the author one edit.
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
    /**
     * Allowed HTTP status codes (HTTP / S3 drivers only). When the
     * response status is outside this list, the step fails with
     * `unexpected_status_code`. Postgres steps use
     * `expected_row_count` instead — the two are not interchangeable.
     */
    expected_statuses: z.array(z.number().int()).optional(),
    /**
     * Postgres-only row-count assertion. Accepts:
     *   - number          ⇒ exact match required
     *   - [min, max]      ⇒ inclusive range
     *   - { min: N }      ⇒ at-least N rows
     *   - { max: N }      ⇒ at-most N rows
     *   - { min, max }    ⇒ inclusive range (object form)
     * On miss the step fails with `expected_row_count_mismatch`.
     */
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
    /** Per-output secret marking — wired through the step-runner's
     *  `applyDeclaredSecrets` pass. Keys correspond to top-level
     *  paths inside the step's output. When `secret: true` the value
     *  is replaced with the redaction marker BEFORE offload, preview,
     *  audit, and downstream scope. Used by chained-auth recipes
     *  (Cognito IdToken, OAuth2 access_token / refresh_token). */
    outputs: z.record(z.string().min(1), z.object({ secret: z.boolean().optional() })).optional(),
    /** Read a tenant-encrypted persistent state value before the step
     *  runs. Bound into the substitution scope under
     *  `${state.<into_var>}` for use in `query`, `body`, headers, etc.
     *  When the row does not exist on the first run, `default_value`
     *  is used (typically `null` for cursor-based reverse-ETL). */
    state_read: z
      .object({
        key: z.string().min(1),
        into_var: z.string().min(1),
        default_value: z.unknown().optional(),
      })
      .optional(),
    /** Write a tenant-encrypted persistent state value after the step
     *  succeeds. `value_path` is dot-notation against the step
     *  result envelope (e.g. `body.last_id` or `data[last].updated_at`).
     *  Persisted in the same transaction as the step's output —
     *  a crash between cannot leave the watermark and side-effect
     *  divergent. */
    state_write: z
      .object({
        key: z.string().min(1),
        value_path: z.string().min(1),
      })
      .optional(),
    /** Multipart/form-data upload parts. When present the HTTP driver
     *  builds a FormData body from the resolved parts instead of sending
     *  a JSON body. `$file` parts are resolved by the step-runner before
     *  dispatch; `value` parts become plain text fields. */
    multipart: z.array(MultipartPartSchema).min(1).optional(),
  })
  .refine((s) => s.url !== undefined || s.connector_id !== undefined || s.sql !== undefined, {
    message:
      "request step must specify either url, connector_id, or sql (postgres connectors are routed via the sql block)",
  })
  .superRefine((s, ctx) => {
    // Per-driver method invariants. The shared `method` enum has to
    // accept HTTP + S3 + SQL verbs because legacy callers might still
    // set `step.method` rather than `step.s3.method` / `step.sql.method`.
    // The superRefine catches mixed usage so the LLM gets a typed
    // error at authoring time instead of a runtime drive mismatch.
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
      // S3 block present — step.method must be S3-compatible.
      if (s.method !== undefined && !S3_VERBS.has(s.method)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["method"],
          message: `s3 step requires method ∈ ${[...S3_VERBS].join("|")}, got ${s.method}`,
        });
      }
      // LIST needs a prefix; GET/PUT/HEAD/DELETE need a key (or step.path).
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
      // Cursor + transaction are sql-only knobs but the schema can't
      // know which driver runs at runtime; the dispatch validates.
    }

    // Cross-validate expected_row_count tuples and object bounds at
    // authoring time so the LLM doesn't have to discover an
    // unsatisfiable assertion at runtime.
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
      // GET is the schema default; we only flag a non-default HTTP verb.
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
      // sql.transaction false + sql.also is contradictory.
      if (s.sql.transaction === false && s.sql.also && s.sql.also.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sql", "transaction"],
          message: "sql.transaction cannot be false when sql.also is set",
        });
      }
      // sql.cursor + sql.also conflict — the cursor opens its own
      // implicit transaction.
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
      // An MCP session is negotiated against a registered server, and the
      // connector row is what carries the transport, the credential and
      // the slug the tool name is namespaced by. A bare `url` has none of
      // those, so there is nothing to hand the pool.
      if (s.connector_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["connector_id"],
          message: "mcp step requires connector_id — an MCP server is addressed as a connector",
        });
      }
      // Both assertions read an HTTP/SQL result shape an MCP call never
      // produces: there is no status code on a JSON-RPC result and no
      // row count on remote content.
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
      // `timeout_ms` bounds nothing on this path. An MCP call's deadline
      // belongs to the session that carries it and is set per connector;
      // keeping the step timer out of it is what makes `signal.aborted`
      // there mean "the run was cancelled" and nothing else. A bound that
      // never fires is worse than no field at all — it reads as a bound
      // that holds — so refuse it, and name the lever that does work.
      if (s.timeout_ms !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeout_ms"],
          message:
            "timeout_ms does not bound an mcp step; the deadline for a remote call is the connector's `config.mcp.remote_tool_call_timeout_ms` (tenant default: `connectors.mcp.remote_tool_call_timeout_ms`, ceiling 300000ms)",
        });
      }
    }

    // Pure HTTP path: no s3 / sql / graphql / mcp block ⇒ method must be HTTP.
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

// Web-scraper connector — the three config + three output Zod schemas live
// in `./types-web-scraper.ts` (imported above). The TransformStep
// schema below references them inline; the language enum keeps the new
// values in this file so the discriminated-union shape is visible at a
// glance.

export const TransformStepSchema = z
  .object({
    kind: z.literal("transform"),
    ...baseStep,
    /** Projection source for `jsonata` / `javascript`. Forbidden for the
     *  three web-scraper languages (`readability`, `html-to-markdown`,
     *  `structured-data`), which read the upstream body via `input`. The
     *  `superRefine` below enforces the language ↔ expression contract. */
    expression: z.string().optional(),
    /** Transforms are JavaScript-only (function body, explicit `return`,
     *  data at `input.scope.<step>.data`). JSONata is NOT a transform
     *  language — it survives only in the one-line slots (`data_selector`,
     *  `branch.when`, `output_transform`, `${...}` interpolation). The other
     *  values are the web-scraper extractors, configured via their blocks. */
    language: z
      .enum(["javascript", "readability", "html-to-markdown", "structured-data"])
      .optional(),
    /** Web-scraper Readability extraction config. */
    readability: ReadabilityConfigSchema.optional(),
    /** Web-scraper html→markdown serialisation config. */
    markdown: MarkdownConfigSchema.optional(),
    /** Web-scraper JSON-LD / OpenGraph / microdata extraction config. */
    structured_data: StructuredDataConfigSchema.optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    /**
     * Per-step opt-out for non-fatal warnings the author has consciously
     * acknowledged. Currently honoured: `dropped_fields` (suppresses the
     * `transform_dropped_fields` heuristic when the projection
     * intentionally omits source keys). Pre-fix the LLM rewrote correct
     * transforms repeatedly because the warning had no escape hatch.
     */
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
    // Per-language config is only meaningful when the matching language is selected.
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
    // Catch a JSONata expression pasted into a JavaScript transform body.
    // Transforms are JavaScript-only; JSONata survives only in the one-line
    // slots (`data_selector`, `branch.when`, `output_transform`, `${...}`
    // interpolation). The chained pipe `~>` is a JSONata operator and a parse
    // error in JS, so it is an unambiguous signal the author pasted JSONata
    // into a JS transform. (The earlier `$builtin` marker set was over-broad —
    // JS legitimately references `$`-prefixed identifiers.)
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

// Wait step. Same-day in-process pause with restart-safe
// resumption via the `workflow_waits` checkpoint table. Cap is 24h.
// NOT multi-day — that pattern moves to the Schedule + State
// recipe. NOT signal-driven — that's a separate primitive
// (the wait-for-event step).
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

// Wait-for-event step. Signal-driven HITL pause with an HMAC-signed
// approval URL. The step blocks until a row in `workflow_signals` arrives
// with the matching `event_name` and (optionally) a payload that matches
// the dot-notation predicate, OR until `timeout_ms` elapses. On timeout
// the workflow runs the `on_timeout` step id (operator-defined fallback,
// never auto-compensate).
//
// Compile-time `superRefine` (defined on WorkflowDefSchema) enforces that
// `WorkflowDef.timeout_ms ≥ wait_for_event.timeout_ms` so a 30-day
// approval timeout is not silently truncated by the workflow's own cap.
export const WaitForEventStepSchema = z
  .object({
    kind: z.literal("wait_for_event"),
    ...baseStep,
    /** Inbound signal name. Bare-string match against
     *  `workflow_signals.event_name`. */
    event_name: z.string().min(1),
    /** Optional dot-notation predicate against the inbound signal
     *  payload (e.g. `outcome` with `equals: "approved"`). Empty
     *  predicate matches any payload. */
    match: z
      .object({
        path: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      })
      .optional(),
    /** Step-level timeout in milliseconds. Required — there is no
     *  default; the operator must declare an explicit upper bound. */
    timeout_ms: z.number().int().positive(),
    /** Operator-defined fallback step id to run on timeout. The fallback
     *  never auto-triggers compensation; if rollback is desired, the
     *  fallback step itself must call into the saga path. */
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
    over: z.string().optional(),
    /**
     * JS expression form of the source-array selector. The expression
     * body receives a single `sourceData` argument bound to the full
     * execution scope and must return an array. Example:
     *
     *   data_selector: "(sourceData) => sourceData.fetch_projects.data.projects"
     *
     * Failures throw a real exception (`Data selector failed: <msg>`)
     * with the actual JS error, instead of the opaque
     * `loop_over_unresolved` warning that a path-style `over` produces
     * when the path resolves to undefined. Prefer this form when
     * authoring a new loop. `over` (path/JSONata string) is kept for
     * backwards compatibility — exactly one of `over` or
     * `data_selector` must be set.
     */
    data_selector: z.string().optional(),
    body: z.array(z.string()),
    /**
     * Stop after the first body step whose effective on_error policy is
     * "fail". The default preserves the historical collect-all behaviour,
     * while expensive or side-effecting loops can opt into bounded failure.
     */
    fail_fast: z.boolean().optional(),
    /**
     * RETIRED authoring field — legacy passthrough only, never authored
     * anew. Loop items are addressed as `$item` (JSONata) / `${item.…}`
     * (strings), with `$loop_index` for the iteration counter.
     *
     * Historical workflow versions declared `item_var` and their loop
     * bodies reference the bare name; those stored versions keep
     * executing unchanged (the engine binds the bare name ONLY when the
     * stored definition declares it — see `execution/loop-scope.ts`).
     * The field is optional with NO default so migrated/new definitions
     * simply omit it; `validateWorkflowDef` rejects any definition that
     * still declares it (the single enforcement point for every write
     * surface). This is a versioned stored-data contract, not a
     * compatibility flag.
     */
    item_var: z.string().optional(),
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
    // sk-stdlib version active at commit time, set by the engine when a
    // workflow contains steps with language: "javascript". Read by
    // self-healing for drift detection.
    stdlib_version: z.string().optional(),
  })
  .openapi("WorkflowRuntime");

// Trigger spec
//
// Discriminated union over the way an execution can be initiated for
// this workflow. The `request` variant is the historical default and
// matches every workflow authored before this field existed — chat,
// CLI, or HTTP `POST /executions` start the run on demand. Omitting
// the `trigger` block is therefore equivalent to setting
// `{ kind: "request" }`.
//
// The `webhook` and `schedule` variants are reverse-bound by the
// workflow lifecycle (see `webhooks/inbound/service.ts` and
// `scheduler/repo.ts`): saving a workflow with one of these triggers
// upserts the matching `webhooks_inbound` / `workflows_schedules` row
// keyed on `(tenant_id, workflow_id)`; deleting or version-rotating
// the workflow removes the row and emits a `*.trigger.unbound` audit
// entry. This module owns the schema only — executor logic for
// webhook firing lives in `webhooks/inbound/service.ts` and for
// schedule firing in `scheduler/reconciler.ts`.
export const RequestTriggerSchema = z
  .object({
    kind: z.literal("request"),
  })
  .openapi("RequestTrigger");

export const WebhookTriggerSchema = z
  .object({
    kind: z.literal("webhook"),
    /** Inbound provider identifier. Free-form so the operator can pick
     *  a stable slug per integration ("stripe", "github-prod"); paired
     *  with `verify` it picks the signature verifier the inbound
     *  driver runs at request time. */
    source: z.string().min(1),
    /** Provider event names this binding accepts. Empty means "any".
     *  The inbound driver uses this list to drop noisy events before
     *  enqueueing an execution. */
    events: z.array(z.string().min(1)),
    /** Signature-verification mode. `none` is allowed for trusted
     *  ingress (intra-VPC, mTLS-fronted); the driver still requires
     *  the binding row to exist. */
    verify: z.enum(["stripe-signature", "github-hmac", "none"]),
  })
  .openapi("WebhookTrigger");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ScheduleTriggerSchema = z
  .object({
    kind: z.literal("schedule"),
    /** Cron expression in 5-field form (`m h dom mon dow`) or the
     *  engine's `every:N` shorthand for sub-minute cadences. The
     *  scheduler reconciler validates the expression at bind time. */
    cron: z.string().min(1),
    /** IANA timezone name (e.g. "Europe/Berlin"). The reconciler
     *  passes this to pg-boss so cron expressions land at the local
     *  wall-clock time the operator authored. */
    tz: z.string().min(1).default("UTC"),
    /** Connector environment used by unattended runs. Scheduled automation
     *  defaults to prod; authors must opt into dev explicitly. */
    execution_mode: z.enum(["dev", "prod"]).optional(),
    /** When true the scheduler skips firings that fall on weekends.
     *  Holiday calendars are NOT inferred — declare them explicitly
     *  via `skip_dates`. */
    business_days_only: z.boolean().optional(),
    /** Explicit YYYY-MM-DD dates to skip (holidays, freezes). The
     *  reconciler compares against the trigger's `tz` so a date here
     *  means "this calendar day in the workflow's timezone". */
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
  /**
   * Effect advertised when this saved workflow is exposed as an agent tool.
   * Omission stays conservative: an unclassified workflow may be irreversible.
   */
  tool_effect: z.enum(["read", "reversible_write", "irreversible_write"]).optional(),
  /**
   * Optional pointer to the skill the workflow was authored from
   * (typically via `start_workflow_from_recipe`). When set, the workflow
   * validator enforces a structural superset relationship between the
   * skill's `input_schema` / `output_schema` and the workflow's — so a
   * recipe-cloned workflow cannot silently narrow its public contract
   * away from the skill's promise. Null when the workflow was authored
   * from scratch.
   */
  derived_from_skill_id: z.string().nullable().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional literal example input payload (NOT a JSON Schema). Unlike
   * `input_schema` it is never enforced at runtime — it is the concrete
   * shape the author (or a dry-run) supplied. `resolveWorkflowInputContract`
   * (`input-schema-synth.ts`) turns it into a tight, `required`-carrying
   * contract via `sampleToSchema` when no explicit `input_schema` is
   * declared, so `run_workflow` gets a real form for a saved workflow
   * instead of a single free-text prompt. Persisted in the versioned
   * definition JSON so the sample-derived tier fires for SAVED workflows,
   * not just in-flight drafts. Kept as a permissive `unknown` because a
   * sample is any JSON value; only an object-with-keys sample yields a
   * usable contract (a scalar/array/empty-object sample falls through to
   * the structural synth). This is an internal definition field — it is
   * NOT the workflow's public `wf_<slug>` MCP tool input schema (that is
   * the resolved contract, computed from this).
   */
  input_schema_sample: z.unknown().optional(),
  /**
   * Optional JSON-Schema contract for the workflow's FINAL output
   * (post `output_transform` / `response_filters`). The convergence
   * signal of the authoring loop: `dry_run_workflow` validates the
   * preview output against it and a violation blocks the green-preview
   * auto-commit with field-level `$output/...` paths; live runs
   * validate too but only attach a NON-blocking
   * `output_contract_violation` warning to the run result. Lives in
   * the versioned definition JSON (no separate storage). The workflow
   * validator refuses a schema Ajv cannot compile.
   */
  output_schema: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optional JSONata predicate evaluated against the final workflow
   * output after `output_schema` validation. A falsy result raises a
   * typed `validation_failed` error and emits a `validation_failed`
   * drift signal — letting operators encode business invariants the
   * schema cannot ("orders.length > 0", "every charge has currency").
   */
  validation_expression: z.string().min(1).optional(),
  /**
   * Optional JavaScript validator run alongside `validation_expression`.
   * The body executes in the QuickJS sandbox with the final output
   * bound as `input`; a return value of `false` (or any throw) trips
   * `validation_failed`. Use when the invariant needs imperative
   * logic (multi-pass scans, regex, custom comparators) that JSONata
   * can't express.
   */
  validation_function: z.string().min(1).optional(),
  /**
   * Optional final-output transform. JSONata expression applied to
   * the last step's output to produce the workflow's public payload.
   * Equivalent to declaring a trailing `transform` step but keeps
   * the public-facing shape declared at the workflow root.
   */
  output_transform: z.string().min(1).optional(),
  /**
   * Optional final-output transform expressed in JavaScript and
   * evaluated in the QuickJS sandbox (same surface as
   * `validation_function`). The body executes with the last step's
   * output bound as `input`; whatever it returns becomes the
   * workflow's public payload. Throws on the JS side surface as
   * `output_transform_failed`.
   */
  output_transform_function: z.string().min(1).optional(),
  /**
   * Optional response filters applied to the FINAL workflow output
   * (post `output_transform` / `output_transform_function`). Workflow-level
   * filters mask PII or strip internal-only fields from the payload that
   * crosses the tenant boundary, regardless of which step produced them.
   *
   * Per-request filters declared on `RequestStep.response_filters`
   * still operate at step-execution time (mid-pipeline cleanup);
   * workflow-level filters are the last step before the public
   * payload is returned to the caller.
   */
  response_filters: z.array(ResponseFilterSchema).optional(),
  steps: z.array(StepSchema).min(1).max(200),
  timeout_ms: z.number().int().positive().optional(),
  /**
   * Per-run cumulative LLM-token cap. Counts prompt + completion
   * tokens across every LLM-provider call the run issues. The
   * executor enforces this BEFORE issuing each call: when the
   * pre-call estimate would push the running total past the cap, the
   * run fails with the typed `llm_budget_exceeded` error and no
   * provider charge is incurred. Optional; absent means "no per-run
   * cap" (the per-tenant monthly budget still applies independently).
   *
   * Recommended for any AI-augmented recipe where a runaway loop or a
   * prompt-bloat regression could silently rack up four-figure
   * provider bills.
   */
  max_llm_tokens_per_run: z.number().int().positive().optional(),
  runtime: WorkflowRuntimeSchema.optional(),
  /**
   * How runs of this workflow get initiated. Optional — a workflow
   * without a `trigger` block behaves exactly as before this field
   * existed (implicit `{ kind: "request" }`). Setting `webhook` or
   * `schedule` reverse-binds an inbound binding / cron schedule
   * keyed on `(tenant_id, workflow_id)` at save time and removes it
   * on delete or version rotate (see `service.ts`). Executor logic
   * for the non-`request` variants lives in the webhooks + scheduler
   * subsystems; this field is the schema contract only.
   */
  trigger: TriggerSchema.optional(),
});

// Default workflow timeout used when `timeout_ms` is omitted. Mirrors
// `execution/timeouts.ts:WORKFLOW_TIMEOUT_DEFAULT_MS = 6h`. Imported as
// a literal here to avoid a circular dependency on the execution module.
const WORKFLOW_TIMEOUT_DEFAULT_MS_LITERAL = 6 * 60 * 60_000;

export const WorkflowDefSchema = _baseWorkflowDefSchema
  .superRefine((s, ctx) => {
    // The two final-output forms are mutually exclusive — the engine
    // applies whichever one is set first, so accepting both would
    // silently shadow the second. Reject at authoring time.
    if (s.output_transform && s.output_transform_function) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output_transform_function"],
        message:
          "set either `output_transform` (JSONata) or `output_transform_function` (JS), not both",
      });
    }
    if (s.validation_expression && s.validation_function) {
      // Both are allowed at runtime — they evaluate independently and
      // either tripping fails the run. Surface as info, not error,
      // by skipping the issue. Kept here as a hook for a future
      // policy.
    }
    // HITL workflows must declare `WorkflowDef.timeout_ms` at least
    // as long as the longest `wait_for_event.timeout_ms`. Otherwise the
    // workflow's own timeout aborts the wait early — and the operator
    // who minted a 30-day approval link sees the run die at 6h with no
    // signal received.
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

/**
 * Authoritative list of every persistable `WorkflowDef` field, sourced
 * directly from the schema shape. The conversation-draft → WorkflowDef
 * projection (`conversations/persistence/commit-workflow.ts`) iterates this
 * ONE list instead of hand-maintaining a parallel field roster, so a new
 * persistable field added to `WorkflowDefSchema` is projected automatically
 * and can never silently drop on commit. Keyed on the schema (NOT the draft
 * document) so transient draft-only state — `goal`, previews, checkpoints,
 * judge breaker, connector scratch — is deliberately excluded.
 */
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
