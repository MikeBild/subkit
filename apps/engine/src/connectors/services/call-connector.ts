// `call_connector` execution helper behind `POST /v1/connectors/{id}/call`.
//
// The `call_connector` conversation tool answers the same question for the
// authoring loop but does NOT run through here — it has its own dispatch in
// `conversations/tools/call-connector.ts` and reaches two drivers this one
// does not (postgres, s3). The one thing the two do share is
// `callConnectorDriverRefusal` below: what an author is told when the driver
// is not callable this way has to be the same sentence on both surfaces,
// because it is the same fact about the driver.
//
// RBAC is handled by the caller (the route uses the standard
// `requirePermission` middleware). This helper takes over once the
// connector + tenant have been authenticated, and is responsible for:
//
//   1. Connector lookup (tenant-scoped).
//   2. Credential check — return `credential_required` when the
//      connector requires auth and no row is persisted.
//   3. Driver routing — HTTP and GraphQL only here. Every other driver
//      surfaces `driver_not_supported_for_call_connector` so callers can
//      hand off to a workflow step.
//   4. Audit row via `recordConnectorInvoked`.
//   5. Body truncation envelope (`truncated`, `body_byte_count`,
//      optional `raw_ref`) so prompt budgets stay bounded for the LLM
//      surface while the HTTP surface gets the same envelope shape.
//
// Returning a discriminated `{ kind: "ok" | "error", ... }` keeps the
// callers' adapter code thin: the tool wraps it in `ToolResult`, the
// route maps to a JSON envelope.

import { recordConnectorInvoked } from "../../audit/recorders/index.ts";
import { truncateForLlm } from "../../conversations/tools/truncate.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { recordConnectorCall } from "../../observability/instrumentation.ts";
import { query as graphqlQuery } from "../drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../drivers/http.ts";
import { extractCreatedResourceId } from "../egress.ts";
import {
  classifyConnectorHealth,
  type ConnectorHealth,
  connectorHealthHint,
  parseDeprecation,
} from "../health.ts";
import { getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

const RESPONSE_BODY_BUDGET_BYTES = 8 * 1024;

export type CallConnectorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface CallConnectorRequest {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  connector_id: string;
  method: CallConnectorMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
  signal?: AbortSignal;
  /** Surfaces the conversation context onto the audit row when present. */
  conversation_id?: string;
}

export interface CallConnectorOk {
  kind: "ok";
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latency_ms: number;
  body_byte_count: number;
  truncated: boolean;
  raw_ref?: string;
  /**
   * Connector-response health. Connector-level faults (auth_failed /
   * endpoint_gone) mean the connector itself is unusable — the caller must
   * NOT read an empty body as "no data". Request-level verdicts (not_found /
   * rate_limited), the `deprecated` early warning, and transient `degraded`
   * carry guidance but the connector itself is fine.
   */
  health: ConnectorHealth;
  /** Present only when `health !== "ok"`. */
  health_suggestion?: string;
  /** Present only when `health !== "ok"`. */
  next_best_actions?: string[];
  metadata: {
    connector_id: string;
    connector_slug: string;
    driver: string;
    environment: string;
    method: string;
    path: string;
    url_host: string;
  };
}

export type CallConnectorErrorCode =
  | "connector_not_found"
  | "credential_required"
  | "driver_not_supported_for_call_connector"
  | "invalid_input"
  | "call_failed";

export interface CallConnectorErr {
  kind: "error";
  error_code: CallConnectorErrorCode;
  message: string;
  /** Driver of the connector when known — null if the connector itself
   *  could not be resolved. */
  driver: string | null;
  /** Wall-clock latency of the failed attempt; 0 for early failures. */
  latency_ms: number;
  next_best_actions?: string[];
  metadata?: Record<string, unknown>;
}

export type CallConnectorResult = CallConnectorOk | CallConnectorErr;

/**
 * What to tell an author whose connector `call_connector` will not dispatch.
 *
 * Shared by both `call_connector` surfaces so the two cannot answer the same
 * question differently. They deliberately allow different driver sets — this
 * one dispatches http + graphql, the conversation tool also dispatches
 * postgres + s3 — but a driver refused by either is refused for the same
 * reason, and that reason belongs in one place.
 *
 * `mcp` is refused permanently, not "not yet". `call_connector` takes a method,
 * a path and a body; an MCP call names a tool and passes arguments. There is no
 * method to choose and no path to hit, so widening the allowlist would mean
 * inventing a mapping from one shape to the other. The request step's `mcp`
 * sub-block is the shape that already fits, so the refusal names it.
 */
export function callConnectorDriverRefusal(driver: string): {
  message: string;
  next_best_actions: string[];
} {
  if (driver === "mcp") {
    return {
      message:
        'an mcp connector is not called with method+path — an MCP call names a tool and its arguments. Author a request step with an `mcp` block: { connector_id, mcp: { operation: "call_tool", tool, arguments } }.',
      next_best_actions: ["author_workflow"],
    };
  }
  return {
    message: `call_connector does not support ${driver} connectors; use a workflow step`,
    next_best_actions: ["author_workflow"],
  };
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

interface DispatchSuccess {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  url_host: string;
}

async function dispatchHttp(
  req: CallConnectorRequest,
  connector: ConnectorView,
): Promise<DispatchSuccess> {
  const execArgs: Parameters<typeof executeConnectorHttpRequest>[0] = {
    db: req.db,
    tenant_id: req.tenant_id,
    connector,
    method: req.method,
    path_or_url: req.path,
    timeout_ms: req.timeout_ms ?? 30_000,
  };
  if (req.headers) execArgs.headers = req.headers;
  if (req.query) execArgs.query = req.query;
  if (req.body !== undefined) execArgs.body = req.body;
  if (req.signal) execArgs.signal = req.signal;
  const res = await executeConnectorHttpRequest(execArgs);
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    url_host: hostOf(res.url),
  };
}

async function dispatchGraphql(
  req: CallConnectorRequest,
  connector: ConnectorView,
): Promise<DispatchSuccess | { invalid_input: string }> {
  // GraphQL connectors expect `body: { query, variables?, operation? }`. A
  // caller (or an MCP client that stringified the object) may pass it as a
  // JSON string — parse it back before the shape check so the call dispatches.
  const rawBody =
    typeof req.body === "string"
      ? (() => {
          try {
            return JSON.parse(req.body as string);
          } catch {
            return req.body;
          }
        })()
      : req.body;
  const b = rawBody as
    { query?: unknown; variables?: unknown; operation?: unknown } | null | undefined;
  if (!b || typeof b !== "object" || typeof b.query !== "string") {
    return { invalid_input: "graphql connectors require body: {query, variables}" };
  }
  const opArg: {
    db: Db;
    tenant_id: string;
    connector: ConnectorView;
    query: string;
    variables?: Record<string, unknown>;
    operation?: "query" | "mutation" | "subscription";
  } = {
    db: req.db,
    tenant_id: req.tenant_id,
    connector,
    query: b.query,
  };
  if (b.variables && typeof b.variables === "object") {
    opArg.variables = b.variables as Record<string, unknown>;
  }
  if (b.operation === "query" || b.operation === "mutation" || b.operation === "subscription") {
    opArg.operation = b.operation;
  }
  const res = await graphqlQuery(opArg);
  return {
    status: res.status,
    headers: res.headers,
    body: res.body,
    url_host: hostOf(connector.base_url ?? ""),
  };
}

/**
 * Execute an ad-hoc HTTP / GraphQL call against a persisted connector.
 *
 * Audit semantics:
 *   - On every reachable invocation we emit `connector.invoked` —
 *     including upstream 4xx / 5xx (the call happened, only the upstream
 *     responded with an error). We do NOT emit when the connector lookup
 *     fails (`connector_not_found`) or when the credential row is
 *     missing (`credential_required`) — neither path actually invoked
 *     anything. The `driver_not_supported` branch likewise predates the
 *     dispatch.
 */
export async function callConnector(req: CallConnectorRequest): Promise<CallConnectorResult> {
  logger.info({
    module: "connector_service",
    action: "call_connector.started",
    tenant_id: req.tenant_id,
    conversation_id: req.conversation_id,
    connector_id: req.connector_id,
    method: req.method,
  });

  const connector = await getConnector(req.tenant_id, req.connector_id, req.db);
  if (!connector) {
    logger.warn({
      module: "connector_service",
      action: "call_connector.failed",
      tenant_id: req.tenant_id,
      conversation_id: req.conversation_id,
      connector_id: req.connector_id,
      error_code: "connector_not_found",
    });
    return {
      kind: "error",
      error_code: "connector_not_found",
      message: `no connector with id '${req.connector_id}'`,
      driver: null,
      latency_ms: 0,
    };
  }

  if (connector.auth_type !== "none") {
    const cred = await getCredentialForConnector(
      req.tenant_id,
      connector.id,
      connector.environment,
      req.db,
    );
    if (!cred) {
      logger.warn({
        module: "connector_service",
        action: "call_connector.failed",
        tenant_id: req.tenant_id,
        conversation_id: req.conversation_id,
        connector_id: req.connector_id,
        error_code: "credential_required",
      });
      return {
        kind: "error",
        error_code: "credential_required",
        message:
          "connector has no saved credential — collect one (ask_user_form) and persist via save_connector_draft({credential}) first",
        driver: connector.driver,
        latency_ms: 0,
        next_best_actions: ["ask_user_form", "save_connector_draft"],
      };
    }
  }

  const driver = connector.driver;
  if (driver !== "http" && driver !== "graphql") {
    logger.warn({
      module: "connector_service",
      action: "call_connector.failed",
      tenant_id: req.tenant_id,
      conversation_id: req.conversation_id,
      connector_id: req.connector_id,
      error_code: "driver_not_supported_for_call_connector",
      driver,
    });
    const refusal = callConnectorDriverRefusal(driver);
    return {
      kind: "error",
      error_code: "driver_not_supported_for_call_connector",
      message: refusal.message,
      driver,
      latency_ms: 0,
      next_best_actions: refusal.next_best_actions,
    };
  }

  const started = Date.now();
  let dispatch: DispatchSuccess | null = null;
  let invalidInput: string | null = null;
  let errorDetail: string | null = null;

  try {
    if (driver === "graphql") {
      const r = await dispatchGraphql(req, connector);
      if ("invalid_input" in r) {
        invalidInput = r.invalid_input;
      } else {
        dispatch = r;
      }
    } else {
      dispatch = await dispatchHttp(req, connector);
    }
  } catch (err) {
    errorDetail = err instanceof Error ? err.message : String(err);
  }

  const latency_ms = Date.now() - started;

  // Validation failures (`invalid_input`) never reach the wire — no
  // audit row, just a typed rejection. Network failures DO get audited
  // because the call was attempted.
  if (invalidInput) {
    return {
      kind: "error",
      error_code: "invalid_input",
      message: invalidInput,
      driver,
      latency_ms,
    };
  }

  const status = dispatch?.status ?? 0;
  const url_host = dispatch?.url_host ?? "";
  // A response that completed at the transport layer can still prove the
  // connector unusable (rejected credential, removed endpoint, Seraph
  // anonymous-200). Classify so the audit row and the LLM-facing envelope
  // both reflect that instead of recording a blind "success".
  const health = dispatch ? classifyConnectorHealth(status, dispatch.headers) : "ok";

  // Phase 2: per-call health counter — a climbing non-ok share for a slug is
  // the leading signal of connector drift (rotated credential, removed
  // endpoint, vendor degradation) before it cascades into failed workflows.
  recordConnectorCall({ slug: connector.slug, health });

  // for a write call (non-idempotent method) lift the created/sent
  // resource id from the response so the audit row records WHAT went out.
  const createdResourceId = dispatch
    ? extractCreatedResourceId(req.method, dispatch.body)
    : undefined;

  await recordConnectorInvoked({
    tenant_id: req.tenant_id,
    actor_id: req.actor_id,
    executor: req.db,
    connector_id: connector.id,
    connector_slug: connector.slug,
    driver,
    environment: connector.environment,
    method: req.method,
    path: req.path,
    url_host,
    status_code: status,
    latency_ms,
    // `deprecated` is a successful response that merely announces a future
    // removal — it must audit as success, not error.
    outcome: errorDetail || (health !== "ok" && health !== "deprecated") ? "error" : "success",
    ...(req.conversation_id ? { conversation_id: req.conversation_id } : {}),
    ...(createdResourceId ? { created_resource_id: createdResourceId } : {}),
  });

  if (errorDetail || !dispatch) {
    logger.warn({
      module: "connector_service",
      action: "call_connector.failed",
      tenant_id: req.tenant_id,
      conversation_id: req.conversation_id,
      connector_id: connector.id,
      method: req.method,
      latency_ms,
      error: errorDetail,
    });
    return {
      kind: "error",
      error_code: "call_failed",
      message: errorDetail ?? "unknown driver failure",
      driver,
      latency_ms,
      metadata: { connector_id: connector.id, connector_slug: connector.slug },
    };
  }

  const body_byte_count = approximateByteLength(dispatch.body);
  const truncatedBody = truncateForLlm(dispatch.body);
  const truncatedHeaders = truncateForLlm(dispatch.headers);

  logger.info({
    module: "connector_service",
    action: "call_connector.succeeded",
    tenant_id: req.tenant_id,
    conversation_id: req.conversation_id,
    connector_id: connector.id,
    method: req.method,
    status,
    latency_ms,
    body_byte_count,
    truncated: truncatedBody.truncated,
  });

  const ok: CallConnectorOk = {
    kind: "ok",
    status,
    headers: (truncatedHeaders.data as Record<string, string>) ?? {},
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
      method: req.method,
      path: req.path,
      url_host,
    },
  };
  if (truncatedBody.truncated && truncatedBody.raw_ref) {
    ok.raw_ref = truncatedBody.raw_ref;
  }
  const hint = connectorHealthHint(health, connector.slug, {
    path: req.path,
    deprecation: dispatch ? parseDeprecation(dispatch.headers) : null,
  });
  if (hint) {
    ok.health_suggestion = hint.suggestion;
    ok.next_best_actions = hint.next_best_actions;
  }
  return ok;
}

export const CALL_CONNECTOR_BODY_BUDGET_BYTES = RESPONSE_BODY_BUDGET_BYTES;
