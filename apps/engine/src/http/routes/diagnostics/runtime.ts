// Live process-runtime snapshot. Reads current values directly from the
// running process (not a metric-registry scrape) so an operator/probe can
// confirm memory, DB-pool, and event-loop-lag health at the instant of the
// request.
//
//   GET /v1/diagnostics/runtime
//
// Host-global (not tenant-scoped), gated by `audit:read` like
// /v1/diagnostics/llm.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getPool } from "../../../db/client.ts";
import { getLastEventLoopLagMs } from "../../../observability/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import { DiagnosticsRuntimeSchema } from "./schemas.ts";

const BYTES_PER_MB = 1024 * 1024;
const toMb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 10) / 10;

const runtimeRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/runtime",
  tags: ["diagnostics"],
  summary: "Live process runtime snapshot (memory / db pool / event-loop lag)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiagnosticsRuntimeSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerRuntimeRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(runtimeRoute, async (c) => {
    requireAuth(c);
    const mem = process.memoryUsage();
    const pool = getPool();
    return c.json(
      {
        uptime_s: Math.round(process.uptime()),
        memory: {
          rss_mb: toMb(mem.rss),
          heap_used_mb: toMb(mem.heapUsed),
          heap_total_mb: toMb(mem.heapTotal),
          external_mb: toMb(mem.external),
        },
        db_pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        event_loop_lag_ms: getLastEventLoopLagMs(),
      },
      200,
    );
  });
}
