// `call_connector` — invoke an arbitrary HTTP/GraphQL/Postgres/SFTP/S3
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
// (`sql`, `parameters`, `allow_writes`, `row_limit`, `op`) are optional and
// only consulted on the matching branch. Mismatches (e.g. `op: "list"` on
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
//     100-char SQL summary; for SFTP only the operation kind.
//   - Persistence: the connector MUST be saved (`auth_type !== "none"` ⇒
//     credential row required). Drafts use `probe_connector_draft`.
//   - Body truncation: response bodies > ~8KB are truncated for the LLM
//     and stashed under `raw_ref` for follow-up `get_raw_result` retrieval.
//   - Confirmation: tool-policies.ts owns the policy table; this tool's
//     execution mode is confirm_before_execution by default. Postgres
//     `allow_writes`, SFTP `put`, and S3 `PUT`/`DELETE` ALL flow through
//     the same gate (no auto path).
//   - Postgres safety: writes are rejected BEFORE the SQL hits the
//     database via a regex check on the leading keyword. `row_limit` is
//     enforced by appending `LIMIT $N` when the query has no LIMIT
//     clause; queries with an existing LIMIT are passed through as-is
//     (the operator is presumed to know what they want).
//   - SFTP safety: `get` rejects responses > 1MB with `object_too_large`;
//     `put` rejects request bodies > 1MB with `body_too_large`.
//
// EXECUTION_MODE: confirm_before_execution

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { recordConnectorInvoked } from "../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { query as graphqlQuery } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { pgQueryWithCount } from "../../connectors/drivers/postgres.ts";
import { executeS3Request, type S3Method } from "../../connectors/drivers/s3.ts";
import { executeSftpCommand } from "../../connectors/drivers/sftp.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

const Method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const SftpOp = z.enum(["list", "get", "put"]);

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
        "Path relative to the connector's base_url (e.g. '/v2/droplets'), or a full URL on the same host. For S3, an object key (`/bucket-prefix`). For SFTP, the remote path.",
      ),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Additional headers; the connector's auth header is auto-injected from the saved credential.",
      ),
    body: z.unknown().optional(),
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

    // SFTP fields.
    op: SftpOp.optional().describe("SFTP operation (sftp connectors only)."),
  })
  .openapi("CallConnectorToolInput");

// ---- helpers ---------------------------------------------------------------

const RESPONSE_BODY_BUDGET_BYTES = 8 * 1024;
const SFTP_BODY_CAP_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_ROW_LIMIT = 100;
const SQL_SUMMARY_MAX = 100;

// Postgres mutation guard: leading-keyword check after stripping comments
// and whitespace. The list mirrors what the reference Round-2 PR uses;
// we lean on the side of "if it isn't obviously a SELECT/WITH, reject".
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

type PermissionResult = { allow: true } | { allow: false; reason: string };

async function resolveConversationPrincipal(ctx: ToolContext): Promise<ResolvedPrincipal | null> {
  const actorId = ctx.engineClient.context.actor_id;
  const actorType = ctx.engineClient.context.actor_type;
  if (!actorId || actorType === "system") return null;

  if (actorType === "user") {
    const rows = await ctx.db
      .select({ role: users.role, role_id: users.role_id })
      .from(users)
      .where(and(eq(users.id, actorId), eq(users.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = [row.role];
    if (row.role_id) {
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "user",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  if (actorType === "system_account") {
    const rows = await ctx.db
      .select({ role_id: systemAccounts.role_id })
      .from(systemAccounts)
      .where(and(eq(systemAccounts.id, actorId), eq(systemAccounts.tenant_id, ctx.tenant_id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    let roleNames: string[] = ["member"];
    if (row.role_id) {
      const named = await ctx.db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, row.role_id))
        .limit(1);
      if (named[0]?.name) roleNames = [named[0].name];
    }
    return {
      provider: "conversation_tool",
      kind: "system_account",
      id: actorId,
      tenant_id: ctx.tenant_id,
      roles: roleNames,
    };
  }
  return null;
}

async function requirePermission(
  ctx: ToolContext,
  permission: string,
  resource: { type: string; id: string },
): Promise<PermissionResult> {
  const principal = await resolveConversationPrincipal(ctx);
  if (!principal) return { allow: true };
  const decision = await can(ctx.db, {
    tenant_id: ctx.tenant_id,
    principal,
    permission,
    resource,
  });
  if (decision.allow) return { allow: true };
  return { allow: false, reason: decision.reason ?? `permission_denied:${permission}` };
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
    "Invoke an HTTP/GraphQL/Postgres/SFTP/S3 endpoint against a *persisted* connector with its real credential applied. Use this AFTER the connector is saved to sample a response, validate pagination, run an exploratory SELECT, list a remote directory, or check field shapes before proposing a workflow step. Always confirm-before-execute. Returns `{ status, headers, body, latency_ms }`.",
  use_case:
    "Reach for this when the connector is saved and the user (or you) needs to see the actual vendor response shape — for endpoint discovery, pagination probing, sampling rows, or field-name verification — without committing to a workflow draft.",
  important_notes: [
    "Connector must be persisted; for drafts use `probe_connector_draft`.",
    "Auth/credential is injected from the saved row — additional `headers` are merged on top (HTTP).",
    "4xx/5xx responses still return `ok:true` with the upstream status — the LLM should inspect the body and decide.",
    "Response bodies > 8KB are truncated; full payload is available via `get_raw_result(ref=raw_ref)`.",
    "Postgres: writes (INSERT/UPDATE/DELETE/DROP/…) are rejected unless `allow_writes:true` is passed. `row_limit` defaults to 100; queries with an existing LIMIT pass through unchanged.",
    "SFTP: `op` is one of list/get/put. `get` and `put` cap the body at 1 MB.",
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
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = CallConnectorInput.parse(rawArgs);

    logger.info({
      module: "conversation_tool",
      action: "call_connector.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id: args.connector_id,
      method: args.method,
      op: args.op,
    });

    // RBAC. `connector:invoke` does not exist in the catalog; the closest
    // gate is `connector:read` (matches probe_connector + the existing
    // resolver pattern in llm/substitution/resolver.ts).
    const auth = await requirePermission(ctx, "connector:read", {
      type: "connector",
      id: args.connector_id,
    });
    if (!auth.allow) {
      logger.warn({
        module: "conversation_tool",
        action: "call_connector.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: args.connector_id,
        reason: auth.reason,
        error_code: "permission_denied",
      });
      return structuredError("permission_denied", auth.reason, {
        permission: "connector:read",
      });
    }

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
      return structuredError("connector_not_found", `no connector with id '${args.connector_id}'`);
    }

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
    }

    // Driver routing.
    const driver = connector.driver;
    if (
      driver !== "http" &&
      driver !== "graphql" &&
      driver !== "postgres" &&
      driver !== "sftp" &&
      driver !== "s3"
    ) {
      logger.warn({
        module: "conversation_tool",
        action: "call_connector.failed",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        connector_id: args.connector_id,
        error_code: "driver_not_supported_for_call_connector",
        driver,
      });
      return structuredError(
        "driver_not_supported_for_call_connector",
        `call_connector does not support ${driver} connectors yet; use a workflow step`,
        { next_best_actions: ["start_workflow_from_goal"] },
      );
    }

    // Cross-driver input validation: reject obvious shape mismatches BEFORE
    // we touch the network or audit log.
    if (driver === "http" || driver === "graphql") {
      if (args.op !== undefined) {
        return structuredError(
          "invalid_input",
          `'op' is sftp-only; ${driver} connectors take method+path`,
        );
      }
      if (args.sql !== undefined) {
        return structuredError(
          "invalid_input",
          `'sql' is postgres-only; ${driver} connectors take method+path`,
        );
      }
    } else if (driver === "postgres") {
      if (args.method !== undefined || args.op !== undefined) {
        return structuredError(
          "invalid_input",
          "postgres connectors take 'sql' (and optional 'parameters'/'allow_writes'/'row_limit'), not method/op",
        );
      }
      if (!args.sql || args.sql.trim().length === 0) {
        return structuredError("invalid_input", "postgres connectors require non-empty 'sql'");
      }
    } else if (driver === "sftp") {
      if (args.method !== undefined || args.sql !== undefined) {
        return structuredError(
          "invalid_input",
          "sftp connectors take 'op' + 'path' (and optional 'body' for put), not method/sql",
        );
      }
      if (!args.op) {
        return structuredError("invalid_input", "sftp connectors require 'op' (list|get|put)");
      }
      if (!args.path) {
        return structuredError("invalid_input", "sftp connectors require 'path'");
      }
    } else if (driver === "s3") {
      if (args.op !== undefined || args.sql !== undefined) {
        return structuredError(
          "invalid_input",
          "s3 connectors take method (GET|PUT|HEAD|LIST|DELETE) + path, not op/sql",
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
    // What we record in audit metadata. NEVER the full SQL or full body.
    let auditMethod = args.method ?? args.op ?? "";
    let auditPathSummary = args.path ?? "";

    try {
      if (driver === "graphql") {
        // GraphQL connectors: callers pass the operation as
        // `body: { query, variables }`. Anything else is an input error.
        const b = args.body as
          | { query?: unknown; variables?: unknown; operation?: unknown }
          | null
          | undefined;
        if (!b || typeof b !== "object" || typeof b.query !== "string") {
          return structuredError(
            "invalid_input",
            "graphql connectors require body: {query, variables}",
          );
        }
        const opArg: {
          db: typeof ctx.db;
          tenant_id: string;
          connector: typeof connector;
          query: string;
          variables?: Record<string, unknown>;
          operation?: "query" | "mutation" | "subscription";
        } = {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector,
          query: b.query,
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
      } else if (driver === "sftp") {
        const op = args.op as "list" | "get" | "put";
        const path = args.path ?? "";
        if (op === "put") {
          const body = args.body;
          if (typeof body !== "string") {
            return structuredError(
              "invalid_input",
              "sftp put requires 'body' as a string (utf-8 contents to upload)",
            );
          }
          const byteLen = Buffer.byteLength(body, "utf8");
          if (byteLen > SFTP_BODY_CAP_BYTES) {
            return structuredError(
              "body_too_large",
              `sftp put body is ${byteLen} bytes; cap is ${SFTP_BODY_CAP_BYTES}`,
              { byte_count: byteLen, cap_bytes: SFTP_BODY_CAP_BYTES },
            );
          }
          const res = await executeSftpCommand({
            connector,
            command: "PUT",
            path,
            body,
          });
          status = 200;
          responseBody = res;
        } else if (op === "get") {
          const res = await executeSftpCommand({
            connector,
            command: "GET",
            path,
          });
          // Defensive: cap the response too. The driver currently returns
          // a utf-8 string; if the remote object is huge we refuse rather
          // than blowing the LLM context window.
          if (res.command === "GET") {
            const byteLen = Buffer.byteLength(res.body, "utf8");
            if (byteLen > SFTP_BODY_CAP_BYTES) {
              return structuredError(
                "object_too_large",
                `sftp object is ${byteLen} bytes; cap is ${SFTP_BODY_CAP_BYTES}`,
                { byte_count: byteLen, cap_bytes: SFTP_BODY_CAP_BYTES },
              );
            }
          }
          status = 200;
          responseBody = res;
        } else {
          // list
          const res = await executeSftpCommand({
            connector,
            command: "LIST",
            path,
          });
          status = 200;
          responseBody = res;
        }
        responseHeaders = {};
        usedHost = hostOf(connector.dsn ?? "") || "sftp";
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
        });
        status = res.status;
        responseHeaders = res.headers;
        responseBody = res.body;
        usedHost = hostOf(connector.base_url ?? "") || "s3";
      }
    } catch (err) {
      errorDetail = err instanceof Error ? err.message : String(err);
    }

    const latency_ms = Date.now() - started;

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
      outcome: errorDetail ? "error" : "success",
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
      return structuredError("call_failed", errorDetail, {
        latency_ms,
      });
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

    return { ok: true, data };
  },
};
