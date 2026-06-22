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

import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { assertEgressAllowed } from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import {
  type AppliedAuthMethod,
  applyAuthMaterial,
  deriveAppliedAuthMethod,
  resolveConnectorCredential,
  validateOutboundHeaders,
} from "./http.ts";
import type { DriverProbeResult } from "./index.ts";
import { classifyGraphqlProbe } from "./probe-classify.ts";
import { buildProbeDiagnostics } from "./probe-diagnostics.ts";

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
  /** What auth was actually applied — same vocabulary as the HTTP
   *  driver. `oauth2_refreshed` means a stale token was rotated inline
   *  before this request went out. */
  auth_method: AppliedAuthMethod;
}

export interface GraphQLNotImplementedError {
  status: 501;
  headers: Record<string, string>;
  body: { error: { code: "not_implemented"; message: string } };
  bytes_in: number;
  duration_ms: number;
  operation_name: string;
  credential_id: null;
  auth_method: "none";
}

/**
 * GraphQL carries logical failures as a top-level `errors` array — even
 * on HTTP 200 (the AppSync convention: `{ data: null, errors: [...] }`).
 * A non-empty `errors` array means the operation failed; callers MUST
 * treat it as a failed step, not a success. Returns the error messages,
 * or `null` when the response carries no logical errors (the `errors`
 * key is absent or an empty array).
 */
export function graphqlErrorMessages(body: unknown): string[] | null {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => {
    const message = (e as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" && message.length > 0 ? message : "graphql error";
  });
}

function parseConfig(connector: ConnectorView): GraphQLConnectorConfig {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  // A GraphQL API has exactly one endpoint, so `base_url` IS the full URL
  // (e.g. `https://api.example.com/graphql`). There is deliberately no
  // base_url/path split and no `probe_endpoint` join — that machinery
  // exists for the HTTP driver, which addresses many paths under one host.
  // Splitting a single GraphQL endpoint only invites the host-root/`/graphql`
  // mismatch that AppSync rejects with `404 UnknownOperationException`.
  const endpoint = connector.base_url ?? "";
  if (!endpoint) {
    throw new Error(`graphql connector ${connector.id} missing base_url`);
  }
  const out: GraphQLConnectorConfig = { endpoint };
  if (cfg.default_headers && typeof cfg.default_headers === "object") {
    out.default_headers = cfg.default_headers as Record<string, string>;
  }
  return out;
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
  /** Draft-time override: caller already holds the credential in memory
   *  (see draft-credential-cache.ts). Skip the DB lookup — the synthetic
   *  draft connector_id wouldn't resolve anyway. Mirrors the HTTP
   *  driver's `credential_override`. */
  credential_override?: DecryptedCredential | null;
  /** Step-level headers from `request_step.headers`. Take precedence
   *  over `cfg.default_headers` AND the connector's auth-applied
   *  headers (so a workflow author who minted a token in step N can
   *  forward it as `headers: { Authorization: "${scope.…}" }` to a
   *  step N+1 graphql request). Pre-fix this slot didn't exist on the
   *  GraphQL driver and the operator had to switch the connector
   *  driver to `http` to work around (session 1b94070c). */
  extra_headers?: Record<string, string>;
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
      auth_method: "none",
    };
  }
  const cfg = parseConfig(p.connector);
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const { credential, credential_id, oauth2_refreshed } =
    await resolveConnectorCredential(resolveOpts);
  const auth_method = deriveAppliedAuthMethod(credential, oauth2_refreshed);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(cfg.default_headers ?? {}),
  };
  const query: Record<string, string | number | boolean> = {};
  applyAuthMaterial(p.connector, credential, headers, query);
  // Step-level headers override the connector's auth-applied headers
  // — same precedence as the HTTP driver's `buildRequestPlan`. The
  // workflow author's explicit `Authorization` wins over a stale
  // bearer token from the connector credential.
  if (p.extra_headers) {
    // Drop case-twin Authorization first to avoid sending two.
    if ("Authorization" in p.extra_headers || "authorization" in p.extra_headers) {
      delete headers.Authorization;
      delete headers.authorization;
    }
    for (const [k, v] of Object.entries(p.extra_headers)) {
      headers[k] = v;
    }
  }

  // Static query params on the connector apply to the URL too.
  const url = new URL(cfg.endpoint);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }

  // SSRF guard: block private/loopback/link-local targets.
  assertEgressAllowed(url, { tenant_id: p.tenant_id });

  logger.debug({
    module: "connector",
    action: "graphql.request",
    connector_id: p.connector.id,
    operation: p.op.operation,
    operation_name: operationName,
    url_host: new URL(cfg.endpoint).host,
    url: scrubUrl(url),
    has_credential: credential !== null,
    auth_method,
    oauth2_refreshed,
  });
  const fetchImpl = p.fetchImpl ?? fetch;
  injectTraceContext(headers);
  // Last-line defence on the GraphQL pipeline. Same contract guard as
  // the HTTP driver applies to its own `fetch()` — without this a
  // malformed header bag (e.g. a non-RFC-token name from an LLM-authored
  // connector config or step) crashes inside `new Headers()` and the
  // GraphQL surface returns the obtuse "Invalid header name" error.
  // (Audit anti-pattern C1, conversation 730c568a.)
  validateOutboundHeaders(headers);
  const res = await instrument({
    module: "connector",
    action: "driver.graphql.request",
    level: "debug",
    thresholdMs: 1000,
    fields: {
      connector_id: p.connector.id,
      operation: p.op.operation,
      operation_name: operationName,
      url_host: url.host,
    },
    fn: () =>
      fetchImpl(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify({ query: p.op.query, variables: p.op.variables ?? {} }),
      }),
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
  const errorMessages = graphqlErrorMessages(parsed);
  if (errorMessages !== null || res.status >= 400) {
    logger.warn({
      module: "connector",
      action: "graphql.request.error",
      connector_id: p.connector.id,
      operation: p.op.operation,
      operation_name: operationName,
      status: res.status,
      has_graphql_errors: errorMessages !== null,
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
    auth_method,
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
  credential_override?: DecryptedCredential | null;
  extra_headers?: Record<string, string>;
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
  if (p.extra_headers !== undefined) args.extra_headers = p.extra_headers;
  if (p.fetchImpl !== undefined) args.fetchImpl = p.fetchImpl;
  if (p.credential_override !== undefined) args.credential_override = p.credential_override;
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
  credential_override?: DecryptedCredential | null;
}): Promise<DriverProbeResult> {
  const start = Date.now();
  try {
    // Guard: auth-required connectors must have a persisted credential row
    // (or an in-memory override supplied by the draft probe path).
    // Without one the request would go out unauthenticated and surface a
    // misleading error indistinguishable from a real connectivity failure.
    if (p.connector.auth_type !== "none") {
      const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
        db: p.db,
        tenant_id: p.tenant_id,
        connector: p.connector,
      };
      if (p.credential_override !== undefined) resolveOpts.override = p.credential_override;
      const { credential } = await resolveConnectorCredential(resolveOpts);
      if (!credential) {
        return {
          ok: false,
          latency_ms: 0,
          detail: "credential_required",
          error_code: "credential_missing",
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
    if (p.credential_override !== undefined) args.credential_override = p.credential_override;
    const res = await executeGraphQLRequest(args);
    if (res.status === 501) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        status: 501,
        detail: "graphql endpoint returned 501 (not implemented)",
        error_code: "unknown_upstream_error",
      };
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
    if (!ok) {
      const msgs = graphqlErrorMessages(res.body);
      // Carry the upstream's own words — the first GraphQL error
      // message as `detail`, plus the scrubbed body snippet and the
      // allowlisted diagnostic headers. Pre-fix a 403 probe surfaced
      // only "HTTP 403" while the response body named the real cause.
      return {
        ok,
        latency_ms,
        status: res.status,
        detail: msgs?.[0] ?? `HTTP ${res.status}`,
        error_code: classifyGraphqlProbe(res.status, msgs),
        ...buildProbeDiagnostics(res.headers, res.body),
      };
    }
    return { ok, latency_ms, status: res.status };
  } catch (err) {
    // Network-level error: not classifiable as a credential verdict.
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "graphql.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      ...errorFields(err),
    });
    // Consistent with the other drivers' catch paths: a transport failure is
    // not a credential verdict, so it must NOT flag — but stamp the neutral
    // unknown_upstream_error so every ok:false result carries an error_code.
    return {
      ok: false,
      latency_ms,
      detail: err instanceof Error ? err.message : String(err),
      error_code: "unknown_upstream_error",
    };
  }
}
