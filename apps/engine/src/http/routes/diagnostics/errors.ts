// Engine error-ring tail endpoint.
//
//   GET /v1/diagnostics/errors
//
// The ring is populated by `errorMiddleware` on every 5xx (unhandled
// `internal_error` + LLM-mapped 502/504 + typed 5xx HttpErrors). The
// CLI's `/logs` slash command reads this so operators can correlate a
// `trace_id` from the user-facing banner to the actual server-side
// cause without SSH-ing into the engine container.
//
// Tenant scoping: a request without a tenant context (e.g. an early
// auth failure) gets `tenant_id: null` in the ring. We filter strictly
// to the caller's tenant; the rare auth-time failure stays invisible
// by design.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import { ErrorSchema } from "../../../api/common-schemas.ts";
import { errorRing } from "../../../observability/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { ListQuery, ListResponse } from "./schemas.ts";

const listRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/errors",
  tags: ["diagnostics"],
  summary: "Tail the engine error ring (last N captured 5xx)",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerErrorsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const q = c.req.valid("query");
    const opts: { limit?: number; since?: Date; trace_id?: string; tenant_id: string } = {
      tenant_id: principal.tenant_id,
    };
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.trace_id !== undefined) opts.trace_id = q.trace_id;
    if (q.since !== undefined) opts.since = new Date(q.since);
    const items = errorRing.tail(opts);
    return c.json({ items, total_buffered: errorRing.size() }, 200);
  });
}
