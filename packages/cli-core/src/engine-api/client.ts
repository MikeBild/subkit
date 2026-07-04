// Shared, fully-typed engine HTTP client for the `sk` CLI and its
// compatibility alias.
//
// Built on `openapi-fetch` against `openapi.d.ts` regenerated from the
// engine's own Zod-OpenAPI surface. Both entry points consume this module
// instead of maintaining their own `engine-client.ts` — types drift is
// now a CI failure (see `scripts/gen-openapi-client.ts` + the
// `gen:openapi-client` npm script).
//
// Auth is applied at client-creation time via a standard `fetch`
// middleware so per-request code doesn't touch headers. The client is
// deliberately thin — CLIs layer retry / SSE helpers on top (see
// `@cli-core/sse.ts`).

import createClient, { type ClientOptions, type Middleware } from "openapi-fetch";
import type { paths } from "./openapi.d.ts";

export type EngineClient = ReturnType<typeof createClient<paths>>;

export interface EngineClientOptions {
  /** Engine base URL, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** API key, portal token, or bearer token — applied as `Authorization`. */
  token?: string | undefined;
  /** Optional `x-tenant-id` override (admin flows only). */
  tenantId?: string | undefined;
  /**
   * Optional injection point so tests can pass a `fetch` shim. Defaults
   * to `globalThis.fetch`.
   */
  fetch?: ClientOptions["fetch"];
  /**
   * Extra headers to merge on every request (e.g. user-agent). Token
   * and tenant header are applied separately so they can't be
   * accidentally overwritten.
   */
  headers?: Record<string, string>;
}

function authMiddleware(token: string | undefined, tenantId: string | undefined): Middleware {
  return {
    async onRequest({ request }) {
      if (token) {
        request.headers.set("authorization", `Bearer ${token}`);
      }
      if (tenantId) {
        request.headers.set("x-tenant-id", tenantId);
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
