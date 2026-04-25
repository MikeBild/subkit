// HTTP driver. Resolves connector + credentials and mutates a request
// descriptor so the caller's fetch() lands with the right Authorization
// header, basic-auth base64, bearer token, or appended query.
//
// The driver is intentionally small — it does NOT re-implement the
// retry, timeout, pagination, or filter logic from the P3 request step.
// Instead, the request step imports `applyAuthToRequest` below to mix
// connector auth into its existing HTTP pipeline.

import { refreshIfStale } from "../../credentials/oauth2/refresh-worker.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { tunnelRegistry } from "../../tunnels/registry.ts";
import type { TunnelResponse } from "../../tunnels/types.ts";
import { getConnectorProbeEndpoint } from "../template-binding.ts";
import type { ConnectorView } from "../types.ts";

export interface HttpRequestDescriptor {
  base_url: string | null;
  path_or_url: string; // either an absolute URL or a path relative to base_url
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
}

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * Resolve the final URL for a request relative to a connector's
 * base_url. If the input already absolute, the base_url is ignored.
 */
export function resolveUrl(base_url: string | null, path_or_url: string): URL {
  if (isAbsoluteUrl(path_or_url)) return new URL(path_or_url);
  const base = base_url ?? "";
  if (!base) {
    throw new Error(
      `HTTP driver: no base_url on connector and path "${path_or_url}" is not absolute`,
    );
  }
  // new URL(path, base) — URL normalises leading slashes for us.
  return new URL(path_or_url, base.endsWith("/") ? base : `${base}/`);
}

/**
 * Mutate a header/query bag according to the credential's auth mode.
 * Header/query values authored on the connector (`config.static_headers`,
 * `config.static_query`) land on the request too.
 */
export function applyAuthMaterial(
  connector: ConnectorView,
  credential: DecryptedCredential | null,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean>,
): void {
  const cfg = (connector.config ?? {}) as {
    static_headers?: Record<string, string>;
    static_query?: Record<string, string>;
  };
  if (cfg.static_headers) {
    for (const [k, v] of Object.entries(cfg.static_headers)) {
      headers[k] = v;
    }
  }
  if (cfg.static_query) {
    for (const [k, v] of Object.entries(cfg.static_query)) {
      query[k] = v;
    }
  }
  if (!credential) return;
  switch (credential.mode) {
    case "none":
      return;
    case "header":
      for (const [k, v] of Object.entries(credential.headers)) {
        headers[k] = v;
      }
      return;
    case "query":
      for (const [k, v] of Object.entries(credential.query)) {
        query[k] = v;
      }
      return;
    case "bearer":
      headers.Authorization = `Bearer ${credential.token}`;
      return;
    case "basic": {
      const encoded = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString(
        "base64",
      );
      headers.Authorization = `Basic ${encoded}`;
      return;
    }
    case "oauth2":
      headers.Authorization = `${credential.token_type ?? "Bearer"} ${credential.access_token}`;
      return;
  }
}

export interface ResolveConnectorRequestParams {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}

/** What auth was actually applied — observable at request time.
 *  `oauth2_refreshed` means a stale token was rotated inline before this
 *  request went out; `oauth2_static` means the cached token was still
 *  fresh. Debuggers can spot a token-rotation hiccup this way. */
export type AppliedAuthMethod =
  | "none"
  | "bearer"
  | "header"
  | "query"
  | "basic"
  | "oauth2_static"
  | "oauth2_refreshed";

export interface ResolvedRequestPlan {
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  auth_method: AppliedAuthMethod;
  // When set, the request step should forward this request through the
  // named tunnel target instead of doing a direct `fetch`. The value is
  // the target name registered by the agent during the register frame.
  tunnel_target?: string;
}

function deriveAuthMethod(
  credential: DecryptedCredential | null,
  oauth2Refreshed: boolean,
): AppliedAuthMethod {
  if (!credential) return "none";
  switch (credential.mode) {
    case "none":
      return "none";
    case "bearer":
      return "bearer";
    case "header":
      return "header";
    case "query":
      return "query";
    case "basic":
      return "basic";
    case "oauth2":
      return oauth2Refreshed ? "oauth2_refreshed" : "oauth2_static";
  }
}

/**
 * One-shot: pull the connector's credential, apply it, and return a
 * ready-to-fetch plan. Used both by the request step runner and by the
 * connector.test route.
 */
export async function buildRequestPlan(
  p: ResolveConnectorRequestParams,
): Promise<ResolvedRequestPlan> {
  const headers = { ...(p.headers ?? {}) };
  const query = { ...(p.query ?? {}) };
  let credential: DecryptedCredential | null = null;
  let oauth2Refreshed = false;
  if (p.connector.auth_type !== "none") {
    const row = await getCredentialForConnector(
      p.tenant_id,
      p.connector.id,
      p.connector.environment,
      p.db,
    );
    if (row) {
      credential = row.value;
      if (credential.mode === "oauth2") {
        // Synchronous refresh path — if the token is stale, refresh
        // inline so the caller gets a fresh token on the request. The
        // refresh-worker module documents the rationale.
        const preToken = credential.access_token;
        credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
        if (credential.mode === "oauth2" && credential.access_token !== preToken) {
          oauth2Refreshed = true;
        }
      }
    }
  }
  applyAuthMaterial(p.connector, credential, headers, query);
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const cfg = (p.connector.config ?? {}) as { tunnel_target?: unknown };
  const plan: ResolvedRequestPlan = {
    url,
    headers,
    query,
    credential,
    auth_method: deriveAuthMethod(credential, oauth2Refreshed),
  };
  if (typeof cfg.tunnel_target === "string" && cfg.tunnel_target.length > 0) {
    plan.tunnel_target = cfg.tunnel_target;
  }
  log.connector.request.planned({
    connector_id: p.connector.id,
    auth_type: p.connector.auth_type,
    url_host: url.host,
    has_credential: credential !== null,
    oauth2_refreshed: oauth2Refreshed,
    tunnel_target: plan.tunnel_target ?? null,
  });
  return plan;
}

export interface HttpExecutionResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bytes_in: number;
  url: string;
  tunnel_target?: string;
}

function parseResponseBody(text: string, contentType: string): unknown {
  if (contentType.includes("application/json") && text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export async function executePlannedHttpRequest(params: {
  tenant_id: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
  tunnel_target?: string;
}): Promise<HttpExecutionResult> {
  if (params.tunnel_target) {
    const effectiveBody =
      params.body !== undefined && params.body !== null && params.method !== "GET"
        ? typeof params.body === "string"
          ? params.body
          : JSON.stringify(params.body)
        : null;
    const headers = { ...params.headers };
    if (effectiveBody !== null && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const tunnelRes = await fetchViaTunnel({
      tenant_id: params.tenant_id,
      tunnel_target: params.tunnel_target,
      method: params.method,
      url: params.url,
      headers,
      body: effectiveBody,
    });
    const text = tunnelRes.body ?? "";
    const contentType =
      tunnelRes.headers["content-type"] ?? tunnelRes.headers["Content-Type"] ?? "";
    return {
      status: tunnelRes.status,
      headers: tunnelRes.headers,
      body: parseResponseBody(text, contentType),
      bytes_in: Buffer.byteLength(text, "utf8"),
      url: params.url.toString(),
      tunnel_target: params.tunnel_target,
    };
  }

  const headers = { ...params.headers };
  const init: RequestInit = {
    method: params.method,
    headers,
    signal: params.signal,
  };
  if (
    params.body !== undefined &&
    params.body !== null &&
    params.method !== "GET" &&
    params.method !== "HEAD"
  ) {
    init.body = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    if (!headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(params.url, init);
  const text = await res.text();
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headerObj[k] = v;
  });
  return {
    status: res.status,
    headers: headerObj,
    body: parseResponseBody(text, res.headers.get("content-type") ?? ""),
    bytes_in: Buffer.byteLength(text, "utf8"),
    url: params.url.toString(),
    ...(params.tunnel_target ? { tunnel_target: params.tunnel_target } : {}),
  };
}

export async function executeConnectorHttpRequest(params: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: string;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal?: AbortSignal;
  timeout_ms?: number;
}): Promise<HttpExecutionResult> {
  const planArgs: ResolveConnectorRequestParams = {
    db: params.db,
    tenant_id: params.tenant_id,
    connector: params.connector,
    path_or_url: params.path_or_url,
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.query ? { query: params.query } : {}),
  };
  const plan = await buildRequestPlan(planArgs);
  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  let timeoutSignal: AbortSignal | null = null;
  if (params.timeout_ms !== undefined) {
    timeoutSignal = AbortSignal.timeout(params.timeout_ms);
    signals.push(timeoutSignal);
  }
  const signal =
    signals.length === 0
      ? AbortSignal.timeout(60_000)
      : signals.length === 1
        ? signals[0]!
        : mergeSignals(signals);

  return await executePlannedHttpRequest({
    tenant_id: params.tenant_id,
    method: params.method,
    url: plan.url,
    headers: plan.headers,
    body: params.body,
    signal,
    ...(plan.tunnel_target ? { tunnel_target: plan.tunnel_target } : {}),
  });
}

/**
 * Forward a fully-prepared HTTP request through a registered tunnel.
 * The caller is expected to have built `plan.headers` + `plan.url` via
 * `buildRequestPlan`, so credentials are already injected. The agent
 * just relays the request against its local target.
 */
export async function fetchViaTunnel(params: {
  tenant_id: string;
  tunnel_target: string;
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}): Promise<TunnelResponse> {
  const pathAndQuery = `${params.url.pathname}${params.url.search}`;
  const opts: { timeoutMs?: number } = {};
  if (params.timeoutMs !== undefined) opts.timeoutMs = params.timeoutMs;
  return await tunnelRegistry.forwardRequest(
    params.tenant_id,
    params.tunnel_target,
    {
      target: params.tunnel_target,
      method: params.method,
      path: pathAndQuery,
      headers: params.headers,
      body: params.body ?? null,
    },
    opts,
  );
}

export interface HttpProbeResult {
  ok: boolean;
  latency_ms: number;
  status?: number;
  detail?: string;
  // When true the probe is advisory only — callers should not block on it.
  warning_only: boolean;
  warnings: Array<{ code: string; message: string }>;
}

// Shape stored in connector.config.probe_endpoint (mirrors ProbeEndpointSchema).
interface ProbeEndpointConfig {
  method: "GET" | "HEAD" | "POST";
  path: string;
  expected_status: [number, number];
  description: string;
}

function isProbeEndpointConfig(v: unknown): v is ProbeEndpointConfig {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.path === "string" && Array.isArray(c.expected_status) && c.expected_status.length === 2
  );
}

/**
 * Health probe: do a minimal request against the connector's base_url,
 * respecting `connector.config.probe_endpoint` when present.
 * Falls back to GET / and marks the result warning_only when the
 * fallback returns 404 or 405.
 */
export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return {
        ok: false,
        latency_ms: 0,
        detail: "connector has no base_url",
        warning_only: false,
        warnings: [],
      };
    }

    const rawProbe = getConnectorProbeEndpoint(p.connector);
    const probeConfig = isProbeEndpointConfig(rawProbe) ? rawProbe : null;

    const method = probeConfig?.method ?? "GET";
    // Empty path means probe the base_url directly (no path segment appended).
    const pathOrUrl = probeConfig !== null && probeConfig.path !== "" ? probeConfig.path : "/";

    const res = await executeConnectorHttpRequest({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      method,
      path_or_url: pathOrUrl,
    });

    const latency_ms = Date.now() - start;
    const warnings: Array<{ code: string; message: string }> = [];
    let ok: boolean;
    let warning_only = false;

    if (probeConfig !== null) {
      // Explicit probe: success iff status is within the declared range.
      const [lo, hi] = probeConfig.expected_status;
      ok = res.status >= lo && res.status <= hi;
    } else {
      // Fallback probe: 404/405 from "GET /" is ambiguous — the service may
      // simply not expose that path, not a connectivity failure.
      if (res.status === 404 || res.status === 405) {
        ok = true;
        warning_only = true;
        warnings.push({
          code: "PROBE_AMBIGUOUS",
          message: `Fallback probe GET / returned ${res.status}; connectivity likely OK but endpoint unknown.`,
        });
      } else {
        ok = res.status < 500;
      }
    }

    const result: HttpProbeResult = { ok, latency_ms, status: res.status, warning_only, warnings };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms,
      status: res.status,
    });
    return result;
  } catch (err) {
    const result: HttpProbeResult = {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
      warning_only: false,
      warnings: [],
    };
    log.connector.probe.completed({
      connector_id: p.connector.id,
      ok: result.ok,
      latency_ms: result.latency_ms,
      detail: result.detail,
    });
    return result;
  }
}
