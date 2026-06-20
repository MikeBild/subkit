// Typed HTTP client for the in-process e2e engine.
//
// The existing tier3/tier4 suites hand-roll `adminAuth()` + `jget/jpost`
// closures per file. This factory hoists that pattern into one reusable
// client so the new connector/workflow/execution/knowledge/RBAC suites
// share a single Bearer + tenant-header contract. Mirrors the headers the
// engine's auth middleware reads: `Authorization: Bearer <key>` and the
// optional `x-subkit-tenant` override the tenant-isolation negatives use.

import type { E2EEnv, PersonaName } from "../setup.ts";

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface ApiOptions {
  /** Persona whose API key authenticates the call. Default "admin". */
  persona?: PersonaName;
  /** Override the `x-subkit-tenant` header — used by isolation negatives. */
  tenant?: string;
  /** Override the `x-subkit-environment` header (dev | prod). */
  environment?: "dev" | "prod";
  /** Omit the Authorization header entirely (401 negatives). */
  anonymous?: boolean;
  /** Replace the bearer token with an arbitrary string (bogus-token negatives). */
  bearer?: string;
  /** Extra headers merged last. */
  headers?: Record<string, string>;
}

/** Bound HTTP client over a booted {@link E2EEnv}. */
export interface ApiClient {
  get<T = unknown>(path: string, opts?: ApiOptions): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body: unknown, opts?: ApiOptions): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body: unknown, opts?: ApiOptions): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body: unknown, opts?: ApiOptions): Promise<ApiResponse<T>>;
  del<T = unknown>(path: string, opts?: ApiOptions): Promise<ApiResponse<T>>;
}

function buildHeaders(env: E2EEnv, opts: ApiOptions, withBody: boolean): Record<string, string> {
  const persona = env.personas[opts.persona ?? "admin"];
  const headers: Record<string, string> = {};
  if (withBody) headers["Content-Type"] = "application/json";
  if (!opts.anonymous) {
    headers.Authorization = `Bearer ${opts.bearer ?? persona.apiKey}`;
  }
  if (opts.tenant !== undefined) headers["x-subkit-tenant"] = opts.tenant;
  if (opts.environment) headers["x-subkit-environment"] = opts.environment;
  Object.assign(headers, opts.headers ?? {});
  return headers;
}

async function readBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Non-JSON (HTML error page, SSE preamble). Return raw so callers can
    // still assert on status without the helper masking the failure.
    return text as unknown as T;
  }
}

/** Build an {@link ApiClient} bound to a booted env. */
export function apiClient(env: E2EEnv): ApiClient {
  const send = async <T>(
    method: string,
    path: string,
    opts: ApiOptions,
    body?: unknown,
  ): Promise<ApiResponse<T>> => {
    const withBody = body !== undefined;
    const response = await fetch(`${env.baseUrl}${path}`, {
      method,
      headers: buildHeaders(env, opts, withBody),
      ...(withBody ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: await readBody<T>(response),
      headers: response.headers,
    };
  };

  return {
    get: (path, opts = {}) => send("GET", path, opts),
    post: (path, body, opts = {}) => send("POST", path, opts, body),
    put: (path, body, opts = {}) => send("PUT", path, opts, body),
    patch: (path, body, opts = {}) => send("PATCH", path, opts, body),
    del: (path, opts = {}) => send("DELETE", path, opts),
  };
}
