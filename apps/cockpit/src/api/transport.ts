import type { components } from "@cli-core/engine-api/openapi";
import { connectivity } from "@/app/connectivity";
import { cockpitApiHref } from "@/app/installation-context";
import { acceptTenantContext, noticeTenantContext, tenantContextHeaders } from "./tenant-context";

type Bootstrap = components["schemas"]["CockpitBootstrapResponse"];

let csrfToken: string | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly traceId: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: unknown, traceId: string | null) {
    const record = isRecord(body) ? body : {};
    super(typeof record.message === "string" ? record.message : `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof record.code === "string" ? record.code : null;
    this.traceId = traceId;
    this.details = isRecord(record.details) ? record.details : null;
  }
}

const sessionExpiryListeners = new Set<() => void>();

function isSessionExpiry(status: number, code: string | null): boolean {
  return (
    (status === 401 &&
      (code === "unauthorized" ||
        code === "installation_session_required" ||
        code === "cockpit_installation_session_required")) ||
    (status === 403 &&
      (code === "tenant_unavailable" ||
        code === "installation_unavailable" ||
        code === "installation_revoked"))
  );
}

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiryListeners.add(listener);
  return () => {
    sessionExpiryListeners.delete(listener);
  };
}

export function noticeSessionExpiry(status: number, code: string | null): void {
  if (!isSessionExpiry(status, code)) return;
  for (const listener of sessionExpiryListeners) listener();
}

const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);

export function retryQuery(failures: number, error: unknown): boolean {
  if (failures >= 3) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500 || RETRYABLE_CLIENT_STATUSES.has(error.status);
}

export function noticeResponse(status: number, traceId: string | null): void {
  if (status < 500) connectivity.reachable();
  else connectivity.failed(traceId);
}

export function failure(status: number, body: unknown, traceId: string | null): ApiError {
  const error = new ApiError(status, body, traceId);
  noticeSessionExpiry(error.status, error.code);
  noticeTenantContext(error.status, error.code);
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const BOOTSTRAP_TIMEOUT_MS = 5000;

export interface RequestLimits {
  timeoutMs?: number;
}

function limitedSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs === undefined) return signal ?? undefined;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function refreshCsrfToken(): Promise<boolean> {
  try {
    const result = await apiRequest<Bootstrap>("/v1/cockpit/bootstrap");
    if (!acceptTenantContext(result.tenant.id)) return false;
    csrfToken = result.csrf_token;
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  limits: RequestLimits = {},
  csrfRetried = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(tenantContextHeaders())) headers.set(key, value);
  headers.set("accept", "application/json");
  headers.set("x-subkit-client", "cockpit");
  if (init.body && !(init.body instanceof FormData))
    headers.set("content-type", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-subkit-csrf", csrfToken);
  }
  const signal = limitedSignal(init.signal, limits.timeoutMs);
  const response = await fetch(cockpitApiHref(path), {
    ...init,
    ...(signal ? { signal } : {}),
    credentials: "same-origin",
    headers,
  });
  noticeResponse(response.status, response.headers.get("x-trace-id"));
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (
    response.status === 403 &&
    !csrfRetried &&
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    (body as { code?: unknown } | null)?.code === "csrf_rejected" &&
    (await refreshCsrfToken())
  ) {
    return apiRequest<T>(path, init, limits, true);
  }
  if (!response.ok) throw failure(response.status, body, response.headers.get("x-trace-id"));
  return body as T;
}

export function apiUpload<T>(
  path: string,
  body: unknown,
  onProgress: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", cockpitApiHref(path));
    request.withCredentials = true;
    request.setRequestHeader("accept", "application/json");
    request.setRequestHeader("content-type", "application/json");
    request.setRequestHeader("x-subkit-client", "cockpit");
    for (const [key, value] of Object.entries(tenantContextHeaders()))
      request.setRequestHeader(key, value);
    if (csrfToken) request.setRequestHeader("x-subkit-csrf", csrfToken);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      noticeResponse(request.status, request.getResponseHeader("x-trace-id"));
      let parsed: unknown = null;
      try {
        parsed = request.responseText ? JSON.parse(request.responseText) : null;
      } catch {
        parsed = null;
      }
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve(parsed as T);
      } else reject(failure(request.status, parsed, request.getResponseHeader("x-trace-id")));
    };
    request.onerror = () => reject(new ApiError(0, null, null));
    request.send(JSON.stringify(body));
  });
}

export async function apiText(path: string): Promise<string> {
  const headers = new Headers({ accept: "text/plain", "x-subkit-client": "cockpit" });
  for (const [key, value] of Object.entries(tenantContextHeaders())) headers.set(key, value);
  const response = await fetch(cockpitApiHref(path), { credentials: "same-origin", headers });
  noticeResponse(response.status, response.headers.get("x-trace-id"));
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw failure(response.status, body, response.headers.get("x-trace-id"));
  }
  return response.text();
}

export function bootstrapLimits(loaded: Bootstrap | undefined): RequestLimits {
  return loaded ? {} : { timeoutMs: BOOTSTRAP_TIMEOUT_MS };
}

export async function bootstrap(limits: RequestLimits = {}): Promise<Bootstrap> {
  const result = await apiRequest<Bootstrap>("/v1/cockpit/bootstrap", {}, limits);
  if (!acceptTenantContext(result.tenant.id)) {
    throw failure(
      409,
      {
        code: "tenant_context_changed",
        message: "Reload the workspace session before continuing.",
      },
      null,
    );
  }
  csrfToken = result.csrf_token;
  return result;
}

export function csrfHeaders(): Record<string, string> {
  return csrfToken ? { "x-subkit-csrf": csrfToken } : {};
}
