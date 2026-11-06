import createClient, { type ClientOptions, type Middleware } from "openapi-fetch";
import type { paths } from "./openapi.d.ts";

export type EngineClient = ReturnType<typeof createClient<paths>>;

export interface EngineClientOptions {
  baseUrl: string;
  token?: string | undefined;
  tenantId?: string | undefined;
  fetch?: ClientOptions["fetch"];
  headers?: Record<string, string>;
}

function authMiddleware(token: string | undefined, tenantId: string | undefined): Middleware {
  return {
    async onRequest({ request }) {
      if (token) {
        request.headers.set("authorization", `Bearer ${token}`);
      }
      if (tenantId) {
        request.headers.set("x-subkit-tenant", tenantId);
      }
      return request;
    },
  };
}

export function createEngineClient(opts: EngineClientOptions): EngineClient {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl.replace(/\/$/, ""),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
  });
  client.use(authMiddleware(opts.token, opts.tenantId));
  return client;
}

export type { paths } from "./openapi.d.ts";
