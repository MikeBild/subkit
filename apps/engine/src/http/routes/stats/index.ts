import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { Operation } from "../../../api/operations/index.ts";
import {
  connectorsStatsOperation,
  eventsStatsOperation,
  executionsStatsOperation,
  qualityStatsOperation,
} from "../../../api/operations/stats.ts";
import { llmStatsOperation } from "../../../api/operations/stats-llm.ts";
import { operatingFiguresOperation } from "../../../api/operations/stats-operating-figures.ts";
import {
  chatUsageStatsOperation,
  conversationsUsageStatsOperation,
  httpUsageStatsOperation,
  mcpUsageStatsOperation,
} from "../../../api/operations/stats-usage.ts";
import { gateOtherMethods, requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

function registerStatsOperation<I, R>(
  app: OpenAPIHono<AppEnv>,
  otherMethods: MiddlewareHandler<AppEnv>,
  operation: Operation<I, R>,
): void {
  if (operation.http) app.use(operation.http.path, otherMethods);
  toHonoRoute(app, operation);
}

export function registerStatsRoutes(app: OpenAPIHono<AppEnv>): void {
  const otherMethods = gateOtherMethods(["GET", "HEAD"], requirePermission("stats:read"));
  registerStatsOperation(app, otherMethods, executionsStatsOperation);
  registerStatsOperation(app, otherMethods, connectorsStatsOperation);
  registerStatsOperation(app, otherMethods, eventsStatsOperation);
  registerStatsOperation(app, otherMethods, llmStatsOperation);
  registerStatsOperation(app, otherMethods, operatingFiguresOperation);
  registerStatsOperation(app, otherMethods, qualityStatsOperation);
  registerStatsOperation(app, otherMethods, httpUsageStatsOperation);
  registerStatsOperation(app, otherMethods, chatUsageStatsOperation);
  registerStatsOperation(app, otherMethods, mcpUsageStatsOperation);
  registerStatsOperation(app, otherMethods, conversationsUsageStatsOperation);
}
