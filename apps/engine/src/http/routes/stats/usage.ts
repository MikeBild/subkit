import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  chatUsageStatsOperation,
  conversationsUsageStatsOperation,
  httpUsageStatsOperation,
  mcpUsageStatsOperation,
} from "../../../api/operations/stats-usage.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerUsageStatsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, httpUsageStatsOperation);
  toHonoRoute(app, chatUsageStatsOperation);
  toHonoRoute(app, mcpUsageStatsOperation);
  toHonoRoute(app, conversationsUsageStatsOperation);
}
