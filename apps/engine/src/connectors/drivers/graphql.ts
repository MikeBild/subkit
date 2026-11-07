import { ConnectorOperationError } from "@shared/index.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { errorFields, logger } from "../../logging/logger.ts";
import { instrument } from "../../observability/runtime-telemetry.ts";
import { injectTraceContext, scrubUrl } from "../egress.ts";
import { fetchWithEgressGuard } from "../egress-fetch.ts";
import { assertEgressAllowedResolved } from "../egress-guard.ts";
import { requestUsedStoredCredential } from "../reauth.ts";
import { connectorHeaderPolicy, requestHeaderViolations } from "../request-header-policy.ts";
import type { ConnectorView } from "../types.ts";
import { getDriverFetch } from "./fetch-seam.ts";
import { GRAPHQL_PATH_INVALID_MESSAGE, sameOriginEndpoint } from "./graphql-endpoint.ts";
import {
  type AppliedAuthMethod,
  applyAuthMaterial,
  applySignedJwtAuth,
  checkAuthorityRedirect,
  deriveAppliedAuthMethod,
  FETCH_DEADLINE_MS,
  HttpRequestInvalidError,
  type RequestDispatchPolicy,
  type ResolvedConnectorCredential,
  readBodyCapped,
  redactSignedJwtValue,
  resolveConnectorCredential,
  resolveMaxResponseBytes,
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
  credential_id: string | null;
  auth_method: AppliedAuthMethod;
  stored_credential_used: boolean;
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
  stored_credential_used: false;
}

export function graphqlErrorMessages(body: unknown): string[] | null {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => {
    const message = (e as { message?: unknown } | null | undefined)?.message;
    return typeof message === "string" && message.length > 0 ? message : "graphql error";
  });
}

function parseConfig(connector: ConnectorView, endpointOverride?: string): GraphQLConnectorConfig {
  const cfg = (connector.config ?? {}) as Record<string, unknown>;
  if (endpointOverride !== undefined) {
    if (!sameOriginEndpoint(connector.base_url, endpointOverride))
      throw new ConnectorOperationError("graphql_endpoint_invalid", GRAPHQL_PATH_INVALID_MESSAGE, {
        connector_id: connector.id,
      });
    return { endpoint: endpointOverride };
  }
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

function extractOperationName(query: string, fallback: string): string {
  const match = query.match(/^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return match?.[1] ?? fallback;
}

export async function executeGraphQLRequest(p: {
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
    >,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  endpoint?: string;
  op: GraphQLOperation;
  fetchImpl?: typeof fetch;
  credential_override?: DecryptedCredential | null;
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
      stored_credential_used: false,
    };
  }
  const cfg = parseConfig(p.connector, p.endpoint);
  const resolveOpts: Parameters<typeof resolveConnectorCredential>[0] = {
    db: p.db,
    tenant_id: p.tenant_id,
    connector: p.connector,
  };
  if (p.credential_override !== undefined) {
    resolveOpts.override = p.credential_override;
  }
  const {
    credential,
    credential_id,
    credential_revision,
    connection_authority,
    credential_snapshot,
    oauth2_refreshed,
  } = await resolveConnectorCredential(resolveOpts);
  const violations = requestHeaderViolations(
    p.extra_headers ?? {},
    connectorHeaderPolicy(p.connector, credential),
  );
  if (violations.length > 0)
    throw new HttpRequestInvalidError(
      "request headers conflict with connector authentication",
      "headers",
    );
  const auth_method = deriveAppliedAuthMethod(credential, oauth2_refreshed);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(cfg.default_headers ?? {}),
  };
  const query: Record<string, string | number | boolean> = {};
  applyAuthMaterial(p.connector, credential, headers, query);
  if (p.extra_headers) {
    for (const [k, v] of Object.entries(p.extra_headers)) {
      headers[k] = v;
    }
  }

  const url = new URL(cfg.endpoint);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  await assertEgressAllowedResolved(url, { tenant_id: p.tenant_id, exec: p.db });

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
  const fetchImpl = p.fetchImpl ?? getDriverFetch();
  injectTraceContext(headers);
  validateOutboundHeaders(headers);
  const requestedDispatchPolicy = await p.before_dispatch?.({
    credential_id,
    credential_revision,
    connection_authority: connection_authority ?? null,
    ...(credential_snapshot ? { credential_snapshot } : {}),
  });
  const dispatchPolicy =
    credential?.mode === "signed_jwt"
      ? ({ redirect: "manual" } satisfies RequestDispatchPolicy)
      : requestedDispatchPolicy;
  let signedJwtToken: string | null = null;
  if (credential?.mode === "signed_jwt") {
    await assertEgressAllowedResolved(url, { tenant_id: p.tenant_id, exec: p.db });
    signedJwtToken = await applySignedJwtAuth(p.connector, credential, url, headers);
  }
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
      fetchWithEgressGuard(
        url,
        {
          ...(dispatchPolicy ? { redirect: dispatchPolicy.redirect } : {}),
          method: "POST",
          headers,
          body: JSON.stringify({ query: p.op.query, variables: p.op.variables ?? {} }),
          signal: AbortSignal.timeout(FETCH_DEADLINE_MS),
        },
        { tenant_id: p.tenant_id, exec: p.db },
        { fetchImpl },
      ),
  });
  const maxResponseBytes = resolveMaxResponseBytes(p.tenant_id);
  await checkAuthorityRedirect(res, dispatchPolicy);
  const text = await readBodyCapped(res, maxResponseBytes, url.toString());
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
  if (signedJwtToken) parsed = redactSignedJwtValue(parsed, signedJwtToken) as typeof parsed;
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
      error_messages: errorMessages?.slice(0, 5),
    });
  }
  return {
    status: res.status,
    headers: signedJwtToken
      ? (redactSignedJwtValue(headerObj, signedJwtToken) as Record<string, string>)
      : headerObj,
    body: parsed as {
      data?: unknown;
      errors?: unknown;
    },
    bytes_in: Buffer.byteLength(text, "utf8"),
    duration_ms: Date.now() - start,
    operation_name: operationName,
    credential_id,
    auth_method,
    stored_credential_used:
      p.credential_override === undefined &&
      requestUsedStoredCredential({
        credential,
        home: cfg.endpoint,
        url,
        caller_headers: p.extra_headers,
      }),
  };
}

export async function query(p: {
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
    >,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  endpoint?: string;
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
  if (p.endpoint !== undefined) args.endpoint = p.endpoint;
  if (p.extra_headers !== undefined) args.extra_headers = p.extra_headers;
  if (p.before_dispatch !== undefined) args.before_dispatch = p.before_dispatch;
  if (p.fetchImpl !== undefined) args.fetchImpl = p.fetchImpl;
  if (p.credential_override !== undefined) args.credential_override = p.credential_override;
  return await executeGraphQLRequest(args);
}

export async function probeGraphQLConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  fetchImpl?: typeof fetch;
  credential_override?: DecryptedCredential | null;
}): Promise<DriverProbeResult> {
  const start = Date.now();
  try {
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
    const latency_ms = Date.now() - start;
    logger.warn({
      module: "connector",
      action: "graphql.probe.failed",
      connector_id: p.connector.id,
      latency_ms,
      ...errorFields(err),
    });
    return {
      ok: false,
      latency_ms,
      detail: err instanceof Error ? err.message : String(err),
      error_code: "unknown_upstream_error",
    };
  }
}
