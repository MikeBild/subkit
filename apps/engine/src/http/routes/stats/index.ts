import type { OpenAPIHono } from "@hono/zod-openapi";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerStatsConnectorsRoute } from "./connectors.ts";
import { registerStatsEventsRoute } from "./events.ts";
import { registerStatsExecutionsRoute } from "./executions.ts";
import { registerStatsLlmRoute } from "./llm.ts";
import { registerStatsOperatingFiguresRoute } from "./operating-figures.ts";
import { registerStatsQualityRoute } from "./quality.ts";
import { registerUsageStatsRoutes } from "./usage.ts";

export function registerStatsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/stats/executions", requirePermission("stats:read"));
  app.use("/v1/stats/connectors", requirePermission("stats:read"));
  app.use("/v1/stats/events", requirePermission("stats:read"));
  app.use("/v1/stats/llm", requirePermission("stats:read"));
  app.use("/v1/stats/operating-figures", requirePermission("stats:read"));
  app.use("/v1/stats/quality", requirePermission("stats:read"));
  app.use("/v1/stats/http", requirePermission("stats:read"));
  app.use("/v1/stats/chat", requirePermission("stats:read"));
  app.use("/v1/stats/mcp", requirePermission("stats:read"));
  app.use("/v1/stats/conversations", requirePermission("stats:read"));

  registerStatsExecutionsRoute(app);
  registerStatsConnectorsRoute(app);
  registerStatsEventsRoute(app);
  registerStatsLlmRoute(app);
  registerStatsOperatingFiguresRoute(app);
  registerStatsQualityRoute(app);
  registerUsageStatsRoutes(app);
}
