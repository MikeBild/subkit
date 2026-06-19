// Engine self-diagnostics surface — entry point.
//
// The former http/routes/diagnostics.ts split into per-route modules;
// this barrel registers shared per-path RBAC middleware and delegates
// handler registration to each module. Public API unchanged: server.ts
// still calls `registerDiagnosticsRoutes(app)`.
//
//   GET /v1/diagnostics/errors        — tail the in-memory error ring
//   GET /v1/diagnostics/llm           — resolved LLM provider snapshot
//   GET /v1/diagnostics/setup         — operator-facing setup validation
//   GET /v1/diagnostics/drift         — schema-drift report
//   GET /v1/diagnostics/version       — engine version + update posture
//   GET /v1/diagnostics/integrations  — connector/workflow health rollup
//   GET /v1/diagnostics/logs          — paginated log tail
//   GET /v1/diagnostics/logs/stream   — SSE live log tail

import type { OpenAPIHono } from "@hono/zod-openapi";
import { requireAnyPermission, requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerDriftRoute } from "./drift.ts";
import { registerErrorsRoutes } from "./errors.ts";
import { registerIntegrationsRoute } from "./integrations.ts";
import { registerLlmRoutes } from "./llm.ts";
import { registerLogsRoutes } from "./logs.ts";
import { registerSetupRoutes } from "./setup.ts";
import { registerVersionRoute } from "./version.ts";

export function registerDiagnosticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/diagnostics/errors", requirePermission("audit:read"));
  app.use("/v1/diagnostics/llm", requirePermission("audit:read"));
  app.use("/v1/diagnostics/setup", requireAnyPermission(["audit:read", "identity:read"]));
  app.use("/v1/diagnostics/drift", requirePermission("audit:read"));
  app.use("/v1/diagnostics/version", requirePermission("audit:read"));
  app.use("/v1/diagnostics/integrations", requireAnyPermission(["connector:read", "audit:read"]));
  app.use("/v1/diagnostics/logs", requirePermission("audit:read"));
  app.use("/v1/diagnostics/logs/stream", requirePermission("audit:read"));

  registerErrorsRoutes(app);
  registerLlmRoutes(app);
  registerSetupRoutes(app);
  registerDriftRoute(app);
  registerVersionRoute(app);
  registerIntegrationsRoute(app);
  registerLogsRoutes(app);
}
