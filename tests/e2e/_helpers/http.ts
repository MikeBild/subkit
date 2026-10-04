import type { E2EEnv, PersonaName } from "../setup.ts";

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface ApiOptions {
  persona?: PersonaName;
  tenant?: string;
  environment?: "dev" | "prod";
  anonymous?: boolean;
  bearer?: string;
  headers?: Record<string, string>;
}

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
    return text as unknown as T;
  }
}

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
