// `call_connector` — invoke an arbitrary HTTP/GraphQL/Postgres/S3
// endpoint against a *persisted* connector with its real credential applied.
//
// Why this exists:
//   `probe_connector` is a narrow health check (one shot at the configured
//   probe path), and `dry_run_step` requires committing to a workflow draft.
//   Neither covers the agent's iteration loop of "let me try GET
//   /v2/droplets?per_page=10 and look at the response shape" before
//   proposing a step. `call_connector` is exactly that surface: a real,
//   audited, authenticated request against a saved connector, returning
//   `{ status, headers, body, latency_ms }` so the LLM can ground its
//   schema decisions in the actual vendor response.
//
// Schema decision: a single FLAT input shape with `connector.driver` used
// for dispatch. The flat shape is friendlier to the LLM than a
// discriminated union (no `driver_kind` discriminator to remember; the
// connector itself dictates which fields are read). Driver-specific fields
// (`sql`, `parameters`, `allow_writes`, `row_limit`) are optional and
// only consulted on the matching branch. Mismatches (e.g. `sql` on
// an HTTP connector) surface as `invalid_input`.
//
// Policy:
//   - RBAC: `connector:read` on the target connector. (No `connector:invoke`
//     permission exists in the catalog; this is the closest read-style
//     gate, parity with `probe_connector` which also reads + dispatches.)
//   - Audit: emits `connector.invoked` with actor, connector_id, method,
//     URL host, path, status. Body, headers, full SQL, and full request
//     bodies are NEVER recorded — those belong in telemetry, not the
//     audit log (PII risk + cardinality). For Postgres we surface only a
//     100-char SQL summary.
//   - Persistence: the connector MUST be saved (`auth_type !== "none"` ⇒
//     credential row required). Drafts use `probe_connector_draft`.
//   - Body truncation: response bodies > ~8KB are truncated for the LLM
//     and stashed under `raw_ref` for follow-up `get_raw_result` retrieval.
//   - Confirmation: tool-policies.ts owns the policy table; this tool's
//     execution mode is confirm_before_execution by default. Postgres
//     `allow_writes` and S3 `PUT`/`DELETE` ALL flow through the same gate
//     (no auto path).
//   - Postgres safety: writes are rejected BEFORE the SQL hits the
//     database via a regex check on the leading keyword. `row_limit` is
//     enforced by appending `LIMIT $N` when the query has no LIMIT
//     clause; queries with an existing LIMIT are passed through as-is
//     (the operator is presumed to know what they want).
//
// EXECUTION_MODE: confirm_before_execution

import { z } from "@hono/zod-openapi";

import { recordConnectorInvoked } from "../../audit/recorders/index.ts";
import { query as graphqlQuery } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { pgQueryWithCount } from "../../connectors/drivers/postgres.ts";
import { executeS3Request, type S3Method } from "../../connectors/drivers/s3.ts";
import {
  classifyConnectorHealth,
  connectorHealthHint,
  parseDeprecation,
} from "../../connectors/health.ts";
import { getConnector } from "../../connectors/service.ts";
import { callConnectorDriverRefusal } from "../../connectors/services/call-connector.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import { logger } from "../../logging/logger.ts";
import { recordSuccessShape } from "../../schema-versions/service.ts";
import {
  DirectConnectorBindingError,
  type LoadedConnectorCredential,
} from "../../tools/direct-connector-binding.ts";
import { directConnectorGuard, preflightDirectConnector } from "./direct-connector-guard.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

const Method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

const CallConnectorInput = z
  .object({
    connector_id: z.string().uuid("connector_id must be a UUID"),
    // HTTP / S3 fields. `method` and `path` are optional at the schema
    // level because Postgres has no notion of either — driver-level
    // validation flags missing-required-field cases.
    method: Method.optional(),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path relative to the connector's base_url (e.g. '/v2/droplets'), or a full URL on the same host. For S3, an object key (`/bucket-prefix`).",
      ),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Additional headers; the connector's auth header is auto-injected from the saved credential.",
      ),
    // A concrete (non-empty) JSON Schema. `z.unknown()` serialized to `{}`,
    // which makes some MCP clients stringify the object — the GraphQL body
    // `{query, variables}` then arrived as a JSON STRING and the guard below
    // rejected it. A `union(object, string)` emits `anyOf[object, string]`, so
    // clients send a real object; a still-stringified body is accepted here
    // and JSON-parsed at the dispatch guard.
    body: z.union([z.object({}).passthrough(), z.string()]).optional(),
    timeout_ms: z.number().int().min(1000).max(60_000).default(30_000),

    // Postgres fields.
    sql: z.string().min(1).optional().describe("SQL statement (postgres connectors only)."),
    parameters: z
      .array(z.unknown())
      .optional()
      .describe("Positional parameters for the SQL statement (postgres only)."),
    allow_writes: z
      .boolean()
      .optional()
      .describe(
        "Postgres only. When false (default) any non-SELECT/WITH statement is rejected before reaching the database.",
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "Postgres only. Caps SELECT results by appending `LIMIT $N` when the query has no LIMIT clause. Defaults to 100.",
      ),
  })
  .openapi("CallConnectorToolInput");

// ---- helpers ---------------------------------------------------------------

const RESPONSE_BODY_BUDGET_BYTES = 8 * 1024;
const DEFAULT_ROW_LIMIT = 100;
const SQL_SUMMARY_MAX = 100;

// Postgres mutation guard: leading-keyword check after stripping comments
// and whitespace. We lean on the side of "if it isn't obviously a
// SELECT/WITH, reject".
const FORBIDDEN_SQL_LEADING_RE =
  /^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|EXECUTE|CALL)\b/i;
const ALLOWED_SQL_LEADING_RE = /^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i;
const SQL_HAS_LIMIT_RE = /\blimit\s+\d+\b/i;

function stripSqlComments(sql: string): string {
  // Remove /* ... */ block comments and -- line comments so the leading
  // keyword check isn't fooled by `-- harmless\nDROP TABLE x;`.
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

function isReadOnlySql(sql: string): boolean {
  const stripped = stripSqlComments(sql);
  if (FORBIDDEN_SQL_LEADING_RE.test(stripped)) return false;
  return ALLOWED_SQL_LEADING_RE.test(stripped);
}

function summarizeSql(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > SQL_SUMMARY_MAX ? `${flat.slice(0, SQL_SUMMARY_MAX)}…` : flat;
}

function approximateByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return 0;
  }
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Normalize a call path into the path half of the `<METHOD> <path>`
 * endpoint key `schema_versions` rows are keyed by. Full URLs reduce to
 * their pathname and query strings are stripped (well-formed calls carry
 * them in `args.query` anyway) so pagination params don't fan one
 * logical endpoint into many schema rows.
 */
function endpointKeyPath(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    try {
      return new URL(path).pathname;
    } catch {
      // fall through to the relative-path handling below
    }
  }
  const queryStart = path.indexOf("?");
  return queryStart === -1 ? path : path.slice(0, queryStart);
}

function structuredError(
  error_code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    ok: false,
    data: {
      error: { code: error_code, message },
      ...extra,
    },
  };
}

// ---- the tool --------------------------------------------------------------

export const callConnectorTool: ConversationTool = {
  name: "call_connector",
  description:
    "Invoke an HTTP/GraphQL/Postgres/S3 endpoint against a *persisted* connector with its real credential applied. Use this AFTER the connector is saved to sample a response, validate pagination, run an exploratory SELECT, or check field shapes before proposing a workflow step. Always confirm-before-execute. Returns `{ status, headers, body, latency_ms }`.",
  use_case:
    "Reach for this when the connector is saved and the user (or you) needs to see the actual vendor response shape — for endpoint discovery, pagination probing, sampling rows, or field-name verification — without committing to a workflow draft.",
  important_notes: [
    "If a saved workflow already covers this connector + intent, run its `wf_<slug>` tool instead of re-deriving the query here — `call_connector` is for ad-hoc exploration, not for executing known tasks.",
    "Connector must be persisted; for drafts use `probe_connector_draft`.",
    "Auth/credential is injected from the saved row — additional `headers` are merged on top (HTTP).",
    "4xx/5xx responses still return `ok:true` with the upstream status — the LLM should inspect the body and decide.",
    "`health` is `ok|auth_failed|endpoint_gone|deprecated|not_found|rate_limited|degraded`. `auth_failed`/`endpoint_gone` mean the connector itself is unusable: an empty body means 'auth failed / endpoint removed', NOT 'no data' — tell the user to fix the connector. `not_found`/`rate_limited` are request-level (wrong path / throttled); `deprecated` means the call SUCCEEDED but the vendor announced removal — surface the migration hint. Always use `health_suggestion` + `next_best_actions`.",
    "Response bodies > 8KB are truncated; full payload is available via `get_raw_result(ref=raw_ref)`.",
    "Postgres: writes (INSERT/UPDATE/DELETE/DROP/…) are rejected unless `allow_writes:true` is passed. `row_limit` defaults to 100; queries with an existing LIMIT pass through unchanged.",
    "S3: `method` is one of GET/PUT/HEAD/LIST/DELETE; `path` is the object key (or prefix for LIST).",
    "Audit row records actor + connector + method + URL host + status; bodies, headers, full SQL, and full request bodies are NEVER logged.",
  ],
  example_input: {
    connector_id: "00000000-0000-0000-0000-000000000000",
    method: "GET",
    path: "/v2/droplets",
    query: { per_page: 10 },
  },
  inputSchema: CallConnectorInput,
  category: "tenant_read",
  permission: {
    action: "connector:read",
    resourceType: "connector",
    resourceIdArg: "connector_id",
    denyResult: (permission, reason) =>
      structuredError("permission_denied", reason, { permission }),
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = CallConnectorInput.parse(rawArgs);

    logger.info({
      module: "conversation_tool",
      action: "call_connector.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: args.connector_id,
      method: args.method,
    });

    // RBAC (`connector:read`) is enforced centrally via the `permission`
    // descriptor before execute runs — see permission-gate.ts.

    // Connector lookup (tenant-scoped).
    const connector = await getConnector(ctx.tenant_id, args.connector_id, ctx.db);
    if (!connector) {
      logger.warn({
        module: "conversation_tool",
        action: "call_connector.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: args.connector_id,
        error_code: "connector_not_found",
      });
      return structuredError(
        "connector_not_found",
        `no connector with id '${args.connector_id}' — it may have been deleted or never persisted (drafts are not callable). Call list_connectors for the live catalog, or find_connector to resolve by name/slug; do NOT retry this id.`,
        { next_best_actions: ["list_connectors", "find_connector"] },
      );
    }

    const guard = directConnectorGuard(ctx, connector);
    try {
      await preflightDirectConnector(ctx, connector);
    } catch (error) {
      if (error instanceof DirectConnectorBindingError)
        return structuredError(error.code, error.message);
      throw error;
    }
    let loadedCredential: LoadedConnectorCredential = {
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
    };
    // Credential check — required for all auth_type !== "none" connectors.
    if (connector.auth_type !== "none") {
      const cred = await getCredentialForConnector(
        ctx.tenant_id,
        connector.id,
        connector.environment,
        ctx.db,
      );
      if (!cred) {
        logger.warn({
          module: "conversation_tool",
          action: "call_connector.failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: args.connector_id,
          error_code: "credential_required",
        });
        return structuredError(
          "credential_required",
          "connector has no saved credential — collect one (ask_user_form) and persist via save_connector_draft({credential}) first",
          { next_best_actions: ["ask_user_form", "save_connector_draft"] },
        );
      }
      loadedCredential = {
        credential_id: cred.row.id,
        credential_revision: cred.row.authority_revision,
        connection_authority: cred.connection_authority ?? null,
      };
    }

    // Driver routing.
    const driver = connector.driver;
    if (driver !== "http" && driver !== "graphql" && driver !== "postgres" && driver !== "s3") {
      logger.warn({
        module: "conversation_tool",
        action: "call_connector.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: args.connector_id,
        error_code: "driver_not_supported_for_call_connector",
        driver,
      });
      const refusal = callConnectorDriverRefusal(driver);
      return structuredError("driver_not_supported_for_call_connector", refusal.message, {
        next_best_actions: refusal.next_best_actions,
      });
    }

    // Cross-driver input validation: reject obvious shape mismatches BEFORE
    // we touch the network or audit log.
    if (driver === "http" || driver === "graphql") {
      if (args.sql !== undefined) {
        return structuredError(
          "invalid_input",
          `'sql' is postgres-only; ${driver} connectors take method+path`,
        );
      }
    } else if (driver === "postgres") {
      if (args.method !== undefined) {
        return structuredError(
          "invalid_input",
          "postgres connectors take 'sql' (and optional 'parameters'/'allow_writes'/'row_limit'), not method",
        );
      }
      if (!args.sql || args.sql.trim().length === 0) {
        return structuredError("invalid_input", "postgres connectors require non-empty 'sql'");
      }
    } else if (driver === "s3") {
      if (args.sql !== undefined) {
        return structuredError(
          "invalid_input",
          "s3 connectors take method (GET|PUT|HEAD|LIST|DELETE) + path, not sql",
        );
      }
      if (!args.method) {
        return structuredError(
          "invalid_input",
          "s3 connectors require 'method' (one of GET|PUT|HEAD|LIST|DELETE)",
        );
      }
      if (!args.path) {
        return structuredError("invalid_input", "s3 connectors require 'path' (object key or '/')");
      }
    }

    // Postgres write guard — REJECT BEFORE the database sees the SQL.
    if (driver === "postgres") {
      const allowWrites = args.allow_writes === true;
      if (!allowWrites && !isReadOnlySql(args.sql ?? "")) {
        logger.warn({
          module: "conversation_tool",
          action: "call_connector.failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: connector.id,
          error_code: "writes_not_allowed",
        });
        return structuredError(
          "writes_not_allowed",
          "non-SELECT statements are rejected unless allow_writes:true is passed; pass allow_writes:true to confirm a mutating call",
          { next_best_actions: ["call_connector_with_allow_writes"] },
        );
      }
    }

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let responseHeaders: Record<string, string> = {};
    let usedHost = "";
    let errorDetail: string | null = null;
    let authorityChanged = false;
    // What we record in audit metadata. NEVER the full SQL or full body.
    let auditMethod = args.method ?? "";
    let auditPathSummary = args.path ?? "";

    try {
      if (driver === "graphql") {
        // GraphQL connectors: callers pass the operation as
        // `body: { query, variables }`. An MCP client that stringified the
        // object sends a JSON string — parse it back before the shape check
        // so the call still dispatches (defensive; the schema above already
        // steers clients to a real object).
        const rawBody =
          typeof args.body === "string"
            ? (() => {
                try {
                  return JSON.parse(args.body as string);
                } catch {
                  return args.body;
                }
              })()
            : args.body;
        const b = rawBody as
          { query?: unknown; variables?: unknown; operation?: unknown } | null | undefined;
        if (!b || typeof b !== "object" || typeof b.query !== "string") {
          return structuredError(
            "invalid_input",
            "graphql connectors require body: {query, variables}",
          );
        }
        const opArg: Parameters<typeof graphqlQuery>[0] = {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector,
          query: b.query,
          ...(guard ? { before_dispatch: guard } : {}),
        };
        if (b.variables && typeof b.variables === "object") {
          opArg.variables = b.variables as Record<string, unknown>;
        }
        if (
          b.operation === "query" ||
          b.operation === "mutation" ||
          b.operation === "subscription"
        ) {
          opArg.operation = b.operation;
        }
        const res = await graphqlQuery(opArg);
        status = res.status;
        responseHeaders = res.headers;
        responseBody = res.body;
        usedHost = hostOf(connector.base_url ?? "");
      } else if (driver === "http") {
        const execArgs: Parameters<typeof executeConnectorHttpRequest>[0] = {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector,
          method: args.method ?? "GET",
          path_or_url: args.path ?? "",
          timeout_ms: args.timeout_ms,
          ...(guard ? { before_dispatch: guard } : {}),
        };
        if (args.headers) execArgs.headers = args.headers;
        if (args.query) execArgs.query = args.query;
        if (args.body !== undefined) execArgs.body = args.body;
        if (ctx.abortSignal) execArgs.signal = ctx.abortSignal;
        const res = await executeConnectorHttpRequest(execArgs);
        status = res.status;
        responseHeaders = res.headers;
        responseBody = res.body;
        usedHost = hostOf(res.url);
      } else if (driver === "postgres") {
        const sql = args.sql ?? "";
        const rowLimit = args.row_limit ?? DEFAULT_ROW_LIMIT;
        const allowWrites = args.allow_writes === true;
        // Apply row_limit only to read-only queries with no existing
        // LIMIT clause. Mutations (allow_writes:true) and queries that
        // already declare a LIMIT pass through verbatim.
        let finalSql = sql.trim().replace(/;+\s*$/, "");
        if (!allowWrites && !SQL_HAS_LIMIT_RE.test(finalSql)) {
          finalSql = `${finalSql} LIMIT ${rowLimit}`;
        }
        await guard?.(loadedCredential);
        const res = await pgQueryWithCount({
          connector,
          sql: finalSql,
          params: args.parameters ?? [],
        });
        status = 200;
        responseHeaders = {};
        responseBody = { rows: res.rows, row_count: res.row_count ?? res.rows.length };
        usedHost = hostOf(connector.dsn ?? "") || "postgres";
        auditMethod = allowWrites ? "WRITE" : "READ";
        auditPathSummary = summarizeSql(sql);
      } else if (driver === "s3") {
        const method = (args.method ?? "GET") as S3Method;
        const path = args.path ?? "";
        const s3Body =
          typeof args.body === "string"
            ? args.body
            : args.body instanceof Uint8Array
              ? args.body
              : args.body === undefined
                ? null
                : null;
        const res = await executeS3Request({
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector,
          method,
          path,
          body: s3Body,
          ...(guard ? { before_dispatch: guard, timeout_ms: args.timeout_ms } : {}),
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
        });
        status = res.status;
        responseHeaders = res.headers;
        responseBody = res.body;
        usedHost = hostOf(connector.base_url ?? "") || "s3";
      }
    } catch (err) {
      authorityChanged = err instanceof DirectConnectorBindingError;
      errorDetail = err instanceof Error ? err.message : String(err);
    }

    const latency_ms = Date.now() - started;

    // A transport-level success can still prove the connector unusable —
    // a rejected credential (401/403), a removed endpoint (410), or the
    // Atlassian Seraph anonymous-200. Classify on the raw response so an
    // empty body is not mistaken for "no data". HTTP/GraphQL carry real
    // upstream statuses + headers; postgres/s3 synthesize status 200
    // and classify as "ok".
    const health = errorDetail ? "ok" : classifyConnectorHealth(status, responseHeaders);

    // Audit ALWAYS — including when the upstream failed. The audit row
    // never carries the body, headers, or full SQL (PII risk + cardinality).
    await recordConnectorInvoked({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
      connector_id: connector.id,
      connector_slug: connector.slug,
      driver,
      environment: connector.environment,
      method: auditMethod || "",
      path: auditPathSummary,
      url_host: usedHost,
      status_code: status,
      latency_ms,
      // `deprecated` is a successful response that merely announces a future
      // removal — it must audit as success, not error.
      outcome: errorDetail || (health !== "ok" && health !== "deprecated") ? "error" : "success",
      conversation_id: ctx.conversation_id,
    });

    if (errorDetail) {
      logger.warn({
        module: "conversation_tool",
        action: "call_connector.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: connector.id,
        method: auditMethod,
        latency_ms,
        error: errorDetail,
      });
      return structuredError(
        authorityChanged ? "connector_authority_changed" : "call_failed",
        errorDetail,
        {
          latency_ms,
        },
      );
    }

    // Successful calls record the observed top-level shape against
    // `schema_versions` — same-layer parity with `probe_connector`
    // (probe-connector.ts): both surfaces are the LLM's primary "what
    // does this endpoint actually return" evidence, and the authoring
    // context's "Recorded endpoint samples" section + the drift
    // detector read these rows back. Endpoint key is `<METHOD> <path>`
    // so repeat calls against the same endpoint reuse a row.
    // postgres inputs reject `method` at validation time, so this
    // branch only fires for the method+path drivers (http/graphql/s3).
    if (status >= 200 && status < 300 && responseBody !== null && args.method && args.path) {
      try {
        await recordSuccessShape(
          {
            tenant_id: ctx.tenant_id,
            connector_id: connector.id,
            endpoint_key: `${args.method} ${endpointKeyPath(args.path)}`,
            value: responseBody,
          },
          ctx.db,
        );
      } catch (err) {
        // Never let shape recording fail the call — the LLM still
        // needs the response. Log and move on (probe_connector
        // contract).
        logger.warn({
          module: "conversation_tool",
          action: "call_connector.shape_record_failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: connector.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const body_byte_count = approximateByteLength(responseBody);
    const truncatedBody = truncateForLlm(responseBody);
    const truncatedHeaders = truncateForLlm(responseHeaders);

    logger.info({
      module: "conversation_tool",
      action: "call_connector.succeeded",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: connector.id,
      driver,
      method: auditMethod,
      status,
      latency_ms,
      body_byte_count,
      truncated: truncatedBody.truncated,
    });

    const data: Record<string, unknown> = {
      driver_kind: driver,
      status,
      headers: truncatedHeaders.data,
      body: truncatedBody.data,
      latency_ms,
      body_byte_count,
      truncated: truncatedBody.truncated,
      health,
      metadata: {
        connector_id: connector.id,
        connector_slug: connector.slug,
        driver,
        environment: connector.environment,
        method: auditMethod,
        path: auditPathSummary,
        url_host: usedHost,
      },
    };
    if (truncatedBody.truncated && truncatedBody.raw_ref) {
      data.raw_ref = truncatedBody.raw_ref;
    }
    if (body_byte_count > RESPONSE_BODY_BUDGET_BYTES) {
      data.body_byte_count_exceeded_budget = true;
    }
    // When the connector is unusable, tell the LLM explicitly so it reports
    // "auth failed / endpoint gone", not "no results".
    const hint = connectorHealthHint(health, connector.slug, {
      path: args.path ?? null,
      deprecation: parseDeprecation(responseHeaders),
    });
    if (hint) {
      data.health_suggestion = hint.suggestion;
      data.next_best_actions = hint.next_best_actions;
    }

    return { ok: true, data };
  },
};
