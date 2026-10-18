import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireAnyPermission, requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerDriftRoute } from "./drift.ts";
import { registerErrorsRoutes } from "./errors.ts";
import { registerIntegrationsRoute } from "./integrations.ts";
import { registerLlmRoutes } from "./llm.ts";
import { registerLogsRoutes } from "./logs.ts";
import { registerRuntimeRoute } from "./runtime.ts";
import { registerSetupRoutes } from "./setup.ts";
import { registerVersionRoute } from "./version.ts";

export function registerDiagnosticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/diagnostics/errors", requirePermission("audit:read"));
  app.use("/v1/diagnostics/llm", requirePermission("settings:read:global"));
  app.use("/v1/diagnostics/runtime", requirePermission("settings:read:global"));
  app.use("/v1/diagnostics/setup", requirePermission("settings:read:global"));
  app.use("/v1/diagnostics/drift", requirePermission("settings:read:global"));
  app.use("/v1/diagnostics/version", requirePermission("audit:read"));
  app.use("/v1/diagnostics/integrations", requireAnyPermission(["connector:read", "audit:read"]));
  app.use("/v1/diagnostics/logs", requirePermission("audit:read"));
  app.use("/v1/diagnostics/logs/stream", requirePermission("audit:read"));

  registerErrorsRoutes(app);
  registerLlmRoutes(app);
  registerRuntimeRoute(app);
  registerSetupRoutes(app);
  registerDriftRoute(app);
  registerVersionRoute(app);
  registerIntegrationsRoute(app);
  registerLogsRoutes(app);
}
