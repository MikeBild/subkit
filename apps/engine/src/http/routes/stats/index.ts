// Tenant-scoped runtime stats surface. Four read-only routes,
// all gated by the single `stats:read` permission, all returning three
// rollup levels in one response. The data is aggregated at read time
// from `executions` / `audit_log` / `llm_usage` — no new persistence.

import type { OpenAPIHono } from "@hono/zod-openapi";

import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerStatsConnectorsRoute } from "./connectors.ts";
import { registerStatsEventsRoute } from "./events.ts";
import { registerStatsExecutionsRoute } from "./executions.ts";
import { registerStatsLlmRoute } from "./llm.ts";
import { registerStatsQualityRoute } from "./quality.ts";
import { registerUsageStatsRoutes } from "./usage.ts";

export function registerStatsRoutes(app: OpenAPIHono<AppEnv>): void {
  // Single permission gate for the whole surface. Tenant-scoped read —
  // no per-resource grant, so a bare `requirePermission` (no
  // resourceFrom) is correct. Mounted per-path so each route is gated
  // even though they share the prefix.
  app.use("/v1/stats/executions", requirePermission("stats:read"));
  app.use("/v1/stats/connectors", requirePermission("stats:read"));
  app.use("/v1/stats/events", requirePermission("stats:read"));
  app.use("/v1/stats/llm", requirePermission("stats:read"));
  app.use("/v1/stats/quality", requirePermission("stats:read"));
  app.use("/v1/stats/http", requirePermission("stats:read"));
  app.use("/v1/stats/chat", requirePermission("stats:read"));
  app.use("/v1/stats/mcp", requirePermission("stats:read"));
  app.use("/v1/stats/conversations", requirePermission("stats:read"));

  registerStatsExecutionsRoute(app);
  registerStatsConnectorsRoute(app);
  registerStatsEventsRoute(app);
  registerStatsLlmRoute(app);
  registerStatsQualityRoute(app);
  registerUsageStatsRoutes(app);
}
