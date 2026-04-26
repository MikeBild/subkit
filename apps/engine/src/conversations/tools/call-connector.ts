// `call_connector` — invoke an arbitrary HTTP/GraphQL endpoint against a
// *persisted* connector with its real credential applied.
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
// Policy:
//   - RBAC: `connector:read` on the target connector. (No `connector:invoke`
//     permission exists in the catalog; this is the closest read-style
//     gate, parity with `probe_connector` which also reads + dispatches.)
//   - Audit: emits `connector.invoked` with actor, connector_id, method,
//     URL host, path, status. Body and headers are NOT recorded — those
//     belong in telemetry, not the audit log (PII risk).
//   - Persistence: the connector MUST be saved (`auth_type !== "none"` ⇒
//     credential row required). Drafts use `probe_connector_draft`.
//   - Body truncation: response bodies > ~8KB are truncated for the LLM
//     and stashed under `raw_ref` for follow-up `get_raw_result` retrieval.
//   - Confirmation: tool-policies.ts owns the policy table; this tool's
//     execution mode is confirm_before_execution by default.
//
// EXECUTION_MODE: confirm_before_execution

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { recordConnectorInvoked } from "../../audit/recorders/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { query as graphqlQuery } from "../../connectors/drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../../connectors/drivers/http.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import { roles, systemAccounts, users } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { can } from "../../rbac/evaluator.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { truncateForLlm } from "./truncate.ts";

const Method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

const CallConnectorInput = z
  .object({
    connector_id: z.string().uuid("connector_id must be a UUID"),
    method: Method,
    path: z
      .string()
      .min(1)
      .describe(
        "Path relative to the connector's base_url (e.g. '/v2/droplets'), or a full URL on the same host.",
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
  })
  .openapi("CallConnectorToolInput");

// ---- helpers ---------------------------------------------------------------

const RESPONSE_BODY_BUDGET_BYTES = 8 * 1024;

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
    "Invoke an HTTP endpoint against a *persisted* connector with its real credential applied. Use this AFTER the connector is saved to sample a response, validate pagination, or check field shapes before proposing a workflow step. Always confirm-before-execute. Returns `{ status, headers, body, latency_ms }`.",
  use_case:
    "Reach for this when the connector is saved and the user (or you) needs to see the actual vendor response shape — for endpoint discovery, pagination probing, or field-name verification — without committing to a workflow draft.",
  important_notes: [
    "Connector must be persisted; for drafts use `probe_connector_draft`.",
    "Auth is injected from the saved credential — additional `headers` are merged on top.",
    "4xx/5xx responses still return `ok:true` with the upstream status — the LLM should inspect the body and decide.",
    "Response bodies > 8KB are truncated; full payload is available via `get_raw_result(ref=raw_ref)`.",
    "Audit row records actor + connector + method + URL host + status; body/headers are NOT logged.",
    "Currently HTTP/GraphQL only. For S3/Postgres/SFTP/etc. drivers, use a workflow step.",
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
    if (driver !== "http" && driver !== "graphql") {
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
        `call_connector is currently HTTP/GraphQL only; use a workflow step for ${driver} connectors`,
        { next_best_actions: ["start_workflow_from_goal"] },
      );
    }

    const started = Date.now();
    let status = 0;
    let responseBody: unknown = null;
    let responseHeaders: Record<string, string> = {};
    let usedHost = "";
    let errorDetail: string | null = null;

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
      } else {
        const execArgs: Parameters<typeof executeConnectorHttpRequest>[0] = {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          connector,
          method: args.method,
          path_or_url: args.path,
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
      }
    } catch (err) {
      errorDetail = err instanceof Error ? err.message : String(err);
    }

    const latency_ms = Date.now() - started;

    // Audit ALWAYS — including when the upstream failed. The audit row
    // never carries the body or headers (PII risk + cardinality).
    await recordConnectorInvoked({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
      connector_id: connector.id,
      connector_slug: connector.slug,
      driver,
      environment: connector.environment,
      method: args.method,
      path: args.path,
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
        method: args.method,
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
      method: args.method,
      status,
      latency_ms,
      body_byte_count,
      truncated: truncatedBody.truncated,
    });

    const data: Record<string, unknown> = {
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
        method: args.method,
        path: args.path,
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
