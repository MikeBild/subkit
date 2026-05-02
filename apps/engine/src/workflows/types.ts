// Workflow definition zod schemas. The shape is the user-authored DAG that
// gets persisted into `workflow_versions.dag` and consumed by the execution
// engine. P3 ships the core step kinds: request, transform, call, wait,
// branch, parallel, loop. Future phases extend with additional kinds.

import { z } from "@hono/zod-openapi";

/** Parses a multi-line "Name: Value\nOther: Other" header string into a
 *  record, trimming whitespace on both sides. Returns `null` when no
 *  valid header line was found (so validation can fail with a useful
 *  message instead of silently coercing garbage). Empty lines are
 *  tolerated; lines without a `:` are rejected.
 *
 *  Header names are validated as RFC 7230 tokens — without this, a
 *  JSON-encoded string like `'{"Accept": "..."}'` would parse as a
 *  single header named `'{"Accept"'`, slip through validation, and
 *  blow up inside `new Headers()` at fetch time with the obtuse
 *  "Invalid header name" error (conversation 730c568a). */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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
    if (!HTTP_TOKEN_RE.test(name)) return null;
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

function looksLikeJsonObjectOrArray(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!(first === "{" && last === "}") && !(first === "[" && last === "]")) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
  } catch {
    return false;
  }
}

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

    // Pure HTTP path: no s3 / sql / graphql block ⇒ method must be HTTP.
    if (
      s.s3 === undefined &&
      s.sql === undefined &&
      s.graphql === undefined &&
      s.method !== undefined &&
      !HTTP_VERBS.has(s.method)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: `http request step requires method ∈ ${[...HTTP_VERBS].join("|")}, got ${s.method}; add an \`s3\` or \`sql\` block to dispatch through those drivers`,
      });
    }
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
    over: z.string().optional(),
    /**
     * JS expression form of the source-array selector — modeled on the
     * reference impl's `dataSelector`. The expression body receives a
     * single `sourceData` argument bound to the full execution scope
     * and must return an array. Example:
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
    item_var: z.string().default("item"),
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
// webhook firing lives in `webhooks/inbound/service.ts` (#46) and for
// schedule firing in `scheduler/reconciler.ts` (#47).
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
   * can't express. Mirrors the reference impl's `validationFunction`.
   */
  validation_function: z.string().min(1).optional(),
  /**
   * Optional final-output transform. JSONata expression applied to
   * the last step's output to produce the workflow's public payload.
   * Equivalent to declaring a trailing `transform` step but keeps
   * the public-facing shape declared at the workflow root. Mirrors
   * the reference impl's JSONata-equivalent `outputTransform`.
   */
  output_transform: z.string().min(1).optional(),
  /**
   * Optional final-output transform expressed in JavaScript and
   * evaluated in the QuickJS sandbox (same surface as
   * `validation_function`). The body executes with the last step's
   * output bound as `input`; whatever it returns becomes the
   * workflow's public payload. Throws on the JS side surface as
   * `output_transform_failed`. Mirrors the reference impl's JS
   * `outputTransform` arrow-function form.
   */
  output_transform_function: z.string().min(1).optional(),
  /**
   * Optional response filters applied to the FINAL workflow output
   * (post `output_transform` / `output_transform_function`). Mirrors
   * the reference impl's workflow-level `responseFilters` — masks PII
   * or strips internal-only fields from the payload that crosses the
   * tenant boundary, regardless of which step produced them.
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
