// HTTP driver. Resolves connector + credentials and mutates a request
// descriptor so the caller's fetch() lands with the right Authorization
// header, basic-auth base64, bearer token, or appended query.
//
// The driver is intentionally small — it does NOT re-implement the
// retry, timeout, pagination, or filter logic from the P3 request step.
// Instead, the request step imports `applyAuthToRequest` below to mix
// connector auth into its existing HTTP pipeline.

import { getCredentialForConnector } from "../../credentials/service.ts";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { refreshIfStale } from "../../oauth2/refresh-worker.ts";
import { tunnelRegistry } from "../../tunnels/registry.ts";
import type { TunnelResponse } from "../../tunnels/types.ts";
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

export interface ResolvedRequestPlan {
  url: URL;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  credential: DecryptedCredential | null;
  // When set, the request step should forward this request through the
  // named tunnel target instead of doing a direct `fetch`. The value is
  // the target name registered by the agent during the register frame.
  tunnel_target?: string;
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
        credential = await refreshIfStale(p.db, p.tenant_id, row.row, credential);
      }
    }
  }
  applyAuthMaterial(p.connector, credential, headers, query);
  const url = resolveUrl(p.connector.base_url, p.path_or_url);
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, String(v));
  }
  const cfg = (p.connector.config ?? {}) as { tunnel_target?: unknown };
  const plan: ResolvedRequestPlan = { url, headers, query, credential };
  if (typeof cfg.tunnel_target === "string" && cfg.tunnel_target.length > 0) {
    plan.tunnel_target = cfg.tunnel_target;
  }
  return plan;
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
}

/**
 * Health probe: do a minimal HEAD/GET against the connector's base url
 * (or "/" if absolute), applying credentials. Used by
 * `POST /v1/connectors/:id/test`.
 */
export async function probeHttpConnector(p: {
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
}): Promise<HttpProbeResult> {
  const start = Date.now();
  try {
    if (!p.connector.base_url) {
      return { ok: false, latency_ms: 0, detail: "connector has no base_url" };
    }
    const plan = await buildRequestPlan({
      db: p.db,
      tenant_id: p.tenant_id,
      connector: p.connector,
      path_or_url: "/",
    });
    const res = await fetch(plan.url.toString(), {
      method: "GET",
      headers: plan.headers,
    });
    // Drain the body so we don't leak sockets.
    await res.text().catch(() => "");
    const latency_ms = Date.now() - start;
    return {
      ok: res.status < 500,
      latency_ms,
      status: res.status,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
