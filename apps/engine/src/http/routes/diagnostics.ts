// Engine self-diagnostics surface.
//
//   GET  /v1/diagnostics/errors  — tail the in-memory error ring
//
// The ring is populated by `errorMiddleware` on every 5xx (unhandled
// `internal_error` + LLM-mapped 502/504 + typed 5xx HttpErrors). The
// CLI's `/logs` slash command reads this so operators can correlate a
// `trace_id` from the user-facing banner to the actual server-side
// cause without SSH-ing into the engine container.
//
// Tenant scoping: a request without a tenant context (e.g. an early
// auth failure) gets `tenant_id: null` in the ring. We only expose
// rows belonging to the calling tenant + tenant-less rows that share
// the trace_id with one of those rows; otherwise a noisy neighbour
// could leak details across tenants. Kept simple: filter strictly to
// the caller's tenant; the rare auth-time failure stays invisible by
// design.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { globalLlmStatus } from "../../llm/core/invoke.ts";
import { errorRing } from "../../observability/error-ring.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ErrorRingEntrySchema = z
  .object({
    trace_id: z.string().nullable(),
    ts: z.string(),
    tenant_id: z.string().nullable(),
    method: z.string(),
    path: z.string(),
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
    bucket: z.enum([
      "unhandled",
      "llm_provider",
      "llm_no_object",
      "llm_timeout",
      "llm_quota",
      "http",
    ]),
  })
  .openapi("ErrorRingEntry");

const ListResponse = z
  .object({
    items: z.array(ErrorRingEntrySchema),
    total_buffered: z.number().int(),
  })
  .openapi("DiagnosticsErrorListResponse");

const ListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    since: z.string().datetime().optional(),
    trace_id: z.string().optional(),
  })
  .openapi("DiagnosticsErrorListQuery");

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

// LLM routing snapshot (audit-gated). Lets operators + smoke probes
// detect the misconfig that surfaces as `internal_error` on every
// conversation: the dispatch-time provider falls back to the mock
// sentinel because `LLM_PROVIDER` is unset even though the route layer
// inferred a real provider from the API key. Boolean flags only —
// never the secret values themselves.

const LlmStatusSchema = z
  .object({
    provider_env: z.string().nullable(),
    inferred_provider: z.string(),
    anthropic_key_set: z.boolean(),
    gateway_key_set: z.boolean(),
    default_primary: z.string(),
    default_fallback: z.string(),
  })
  .openapi("DiagnosticsLlmStatus");

const llmRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/llm",
  tags: ["diagnostics"],
  summary: "Resolved LLM provider + model snapshot (smoke / triage)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LlmStatusSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerDiagnosticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/diagnostics/*", requirePermission("audit:read"));

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

  app.openapi(llmRoute, async (c) => {
    requireAuth(c);
    return c.json(globalLlmStatus(), 200);
  });
}
