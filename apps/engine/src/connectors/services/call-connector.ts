import { recordConnectorInvoked } from "../../audit/recorders/index.ts";
import type { KnownAuditActorType } from "../../audit/types.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { recordConnectorCall } from "../../observability/instrumentation.ts";
import { truncateForLlm } from "../../tools/truncate.ts";
import { query as graphqlQuery } from "../drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../drivers/http.ts";
import { extractCreatedResourceId } from "../egress.ts";
import {
  type ConnectorHealth,
  classifyConnectorHealth,
  connectorHealthHint,
  parseDeprecation,
} from "../health.ts";
import { clearReauthIfProved } from "../reauth.ts";
import { getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

export type CallConnectorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface CallConnectorRequest {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  actor_type?: KnownAuditActorType;
  connector_id: string;
  method: CallConnectorMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_ms?: number;
  signal?: AbortSignal;
  conversation_id?: string;
}

interface CallConnectorOk {
  kind: "ok";
  status: number;
  headers: Record<string, string>;
  body: unknown;
  latency_ms: number;
  body_byte_count: number;
  truncated: boolean;
  raw_ref?: string;
  health: ConnectorHealth;
  health_suggestion?: string;
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

type CallConnectorErrorCode =
  | "connector_not_found"
  | "connector_disabled"
  | "credential_required"
  | "driver_not_supported_for_call_connector"
  | "invalid_input"
  | "call_failed";

interface CallConnectorErr {
  kind: "error";
  error_code: CallConnectorErrorCode;
  message: string;
  driver: string | null;
  latency_ms: number;
  next_best_actions?: string[];
  metadata?: Record<string, unknown>;
}

type CallConnectorResult = CallConnectorOk | CallConnectorErr;

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

export function callConnectorDisabledRefusal(
  connector: Pick<ConnectorView, "id" | "slug" | "display_name" | "environment">,
): {
  message: string;
  details: {
    step_id: null;
    connector_id: string;
    connector_slug: string;
    connector_name: string;
    environment: "dev" | "prod";
    reason: "disabled";
  };
  next_best_actions: string[];
} {
  return {
    message: `Connector "${connector.slug}" in ${connector.environment} is disabled; enable it before calling it. Nothing was sent.`,
    details: {
      step_id: null,
      connector_id: connector.id,
      connector_slug: connector.slug,
      connector_name: connector.display_name,
      environment: connector.environment,
      reason: "disabled",
    },
    next_best_actions: ["get_connector"],
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
  stored_credential_used: boolean;
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
    stored_credential_used: res.stored_credential_used,
  };
}

async function dispatchGraphql(
  req: CallConnectorRequest,
  connector: ConnectorView,
): Promise<DispatchSuccess | { invalid_input: string }> {
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
    | { query?: unknown; variables?: unknown; operation?: unknown }
    | null
    | undefined;
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
    stored_credential_used: res.stored_credential_used,
  };
}

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

  if (!connector.enabled) {
    logger.warn({
      module: "connector_service",
      action: "call_connector.failed",
      tenant_id: req.tenant_id,
      conversation_id: req.conversation_id,
      connector_id: req.connector_id,
      error_code: "connector_disabled",
    });
    const refusal = callConnectorDisabledRefusal(connector);
    return {
      kind: "error",
      error_code: "connector_disabled",
      message: refusal.message,
      driver: connector.driver,
      latency_ms: 0,
      next_best_actions: refusal.next_best_actions,
      metadata: refusal.details,
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
  const health = dispatch ? classifyConnectorHealth(status, dispatch.headers) : "ok";

  if (dispatch) {
    await clearReauthIfProved(req.db, connector, {
      status,
      health,
      stored_credential_used: dispatch.stored_credential_used,
      body: dispatch.body,
    });
  }

  recordConnectorCall({ slug: connector.slug, health });

  const createdResourceId = dispatch
    ? extractCreatedResourceId(req.method, dispatch.body)
    : undefined;

  await recordConnectorInvoked({
    tenant_id: req.tenant_id,
    actor_id: req.actor_id,
    ...(req.actor_type ? { actor_type: req.actor_type } : {}),
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
