// GraphQL driver. Wraps the global `fetch` so the request step can run
// queries and mutations against any GraphQL endpoint. Uses the same
// auth modes as the HTTP driver (bearer / header / query / basic /
// oauth2) — credentials are applied to the outgoing fetch headers.
//
// The driver speaks the same `{status, headers, body}` envelope as the
// HTTP and S3 drivers so downstream JSONata / selectors keep working.
//
// Subscriptions are deliberately out of scope for this phase; calling
// `query()` with `operation: "subscription"` returns a typed
// `not_implemented` error envelope.

import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/logger.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import { applyAuthMaterial } from "./http.ts";

export interface GraphQLConnectorConfig {
  endpoint: string;
  default_headers?: Record<string, string>;
}

export interface GraphQLOperation {
  operation: "query" | "mutation" | "subscription";
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: { data?: T; errors?: unknown };
  bytes_in: number;
  duration_ms: number;
  operation_name: string;
  /** Credential row id resolved for this call, or null when the
   *  connector is `auth_type=none`. Surfaces through to the egress
   *  audit (`CREDENTIAL_ACCESSED`). */
  credential_id: string | null;
}

export interface GraphQLNotImplementedError {
  status: 501;
  headers: Record<string, string>;
  body: { error: { code: "not_implemented"; message: string } };
  bytes_in: number;
  duration_ms: number;
  operation_name: string;
  credential_id: null;
}

function parseConfig(connector: ConnectorView): GraphQLConnectorConfig {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  const endpoint =
    typeof cfg.endpoint === "string" && cfg.endpoint.length > 0
      ? cfg.endpoint
      : (connector.base_url ?? "");
  if (!endpoint) {
    throw new Error(`graphql connector ${connector.id} missing config.endpoint or base_url`);
  }
  const out: GraphQLConnectorConfig = { endpoint };
  if (cfg.default_headers && typeof cfg.default_headers === "object") {
    out.default_headers = cfg.default_headers as Record<string, string>;
  }
  return out;
}

async function resolveCredential(
  db: Db,
  tenant_id: string,
  connector: ConnectorView,
): Promise<{ value: DecryptedCredential | null; credential_id: string | null }> {
  if (connector.auth_type === "none") return { value: null, credential_id: null };
  const row = await getCredentialForConnector(tenant_id, connector.id, connector.environment, db);
  return { value: row?.value ?? null, credential_id: row?.row.id ?? null };
}

/**
 * Run a GraphQL operation. Mutations and queries take the same path —
 * the only visible difference is the typed step contract. Subscriptions
 * return a structured `not_implemented` error response instead of throwing.
 */
/** Extract the first named operation in the source. Lets request_meta
 *  report e.g. `GetViewerRepos` instead of the bare `query`/`mutation`
 *  keyword — useful when one connector test fires multiple named ops. */
function extractOperationName(query: string, fallback: string): string {
  const match = query.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? fallback;
}

export async function executeGraphQLRequest(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  op: GraphQLOperation;
  fetchImpl?: typeof fetch;
}): Promise<GraphQLResponse | GraphQLNotImplementedError> {
  const start = Date.now();
  const operationName = extractOperationName(p.op.query, p.op.operation);
  if (p.op.operation === "subscription") {
    return {
      status: 501,
      headers: {},
      body: {
        error: {
          code: "not_implemented",
          message: "graphql subscriptions are not supported by this driver",
        },
      },
      bytes_in: 0,
      duration_ms: Date.now() - start,
      operation_name: operationName,
      credential_id: null,
    };
  }
  const cfg = parseConfig(p.connector);
  const { value: credential, credential_id } = await resolveCredential(
    p.db,
    p.tenant_id,
    p.connector,
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(cfg.default_headers ?? {}),
  };
  const query: Record<string, string | number | boolean> = {};
  applyAuthMaterial(p.connector, credential, headers, query);

  // Static query params on the connector apply to the URL too.
  const url = new URL(cfg.endpoint);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }

  // SSRF guard: block private/loopback/link-local targets. GraphQL
  // driver doesn't support tunneling today, so pass tunnel_target=null
  // — the guard fires unconditionally in strict mode.
  assertEgressAllowed(url, { tenant_id: p.tenant_id, tunnel_target: null });

  logger.debug({
    module: "connector",
    action: "graphql.request",
    connector_id: p.connector.id,
    operation: p.op.operation,
    operation_name: operationName,
    url_host: new URL(cfg.endpoint).host,
    url: scrubUrl(url),
    has_credential: credential !== null,
  });
  const fetchImpl = p.fetchImpl ?? fetch;
  injectTraceContext(headers);
  const res = await fetchImpl(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({ query: p.op.query, variables: p.op.variables ?? {} }),
  });
  const text = await res.text();
  let parsed: { data?: unknown; errors?: unknown };
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { data: text };
  }
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  const hasErrors = Array.isArray((parsed as { errors?: unknown }).errors);
  if (hasErrors || res.status >= 400) {
    logger.warn({
      module: "connector",
      action: "graphql.request.error",
      connector_id: p.connector.id,
      operation: p.op.operation,
      operation_name: operationName,
      status: res.status,
      has_graphql_errors: hasErrors,
    });
  }
  return {
    status: res.status,
    headers: headerObj,
    body: parsed as { data?: unknown; errors?: unknown },
    bytes_in: Buffer.byteLength(text, "utf8"),
    duration_ms: Date.now() - start,
    operation_name: operationName,
    credential_id,
  };
}

/**
 * Convenience wrapper used by the request step's `graphql:` branch.
 * Mirrors the call shape of a typed GraphQL client so step authors get
 * a single self-explanatory function.
 */
export async function query(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  query: string;
  variables?: Record<string, unknown>;
  operation?: "query" | "mutation" | "subscription";
  fetchImpl?: typeof fetch;
}): Promise<GraphQLResponse | GraphQLNotImplementedError> {
  const op: GraphQLOperation = {
    operation: p.operation ?? "query",
    query: p.query,
  };
  if (p.variables !== undefined) op.variables = p.variables;
  const args: Parameters<typeof executeGraphQLRequest>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
    op,
  };
  if (p.fetchImpl !== undefined) args.fetchImpl = p.fetchImpl;
  return await executeGraphQLRequest(args);
}

/**
 * Health probe: POST `{__typename}` against the endpoint and assert
 * `data.__typename` is a string. Treats credential / network failures
 * as "unhealthy".
 */
export async function probeGraphQLConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; latency_ms: number; status?: number; detail?: string }> {
  const start = Date.now();
  try {
    // Guard: auth-required connectors must have a persisted credential row.
    // Without one the request would go out unauthenticated and surface a
    // misleading error indistinguishable from a real connectivity failure.
    if (p.connector.auth_type !== "none") {
      const { value: credValue } = await resolveCredential(p.db, p.tenant_id, p.connector);
      if (!credValue) {
        return {
          ok: false,
          latency_ms: 0,
          detail: "credential_required",
        };
      }
    }

    const args: Parameters<typeof executeGraphQLRequest>[0] = {
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      op: { operation: "query", query: "{ __typename }" },
    };
    if (p.fetchImpl !== undefined) args.fetchImpl = p.fetchImpl;
    const res = await executeGraphQLRequest(args);
    if (res.status === 501) {
      return { ok: false, latency_ms: Date.now() - start, status: 501 };
    }
    const data = (res.body as { data?: { __typename?: unknown } }).data;
    const typeName = data?.__typename;
    const ok = typeof typeName === "string" && res.status >= 200 && res.status < 300;
    const latency_ms = Date.now() - start;
    logger.debug({
      module: "connector",
      action: "graphql.probe.completed",
      connector_id: p.connector.id,
      ok,
      latency_ms,
      status: res.status,
    });
    return { ok, latency_ms, status: res.status };
  } catch (err) {
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "graphql.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, latency_ms, detail: err instanceof Error ? err.message : String(err) };
  }
}
