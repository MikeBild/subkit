// Executions HTTP surface — entry point.
//
// Phase 4 of the 2026-05 architecture audit (#92). The former
// http/routes/executions.ts (865 LOC) split into four sub-resource
// modules — list (read endpoints), run (POST /v1/executions),
// transform (stateless POST /v1/executions/transform), cancel.
// Public API unchanged: server.ts still calls
// `registerExecutionRoutes(app)`.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";
import { registerCancelRoute } from "./cancel.ts";
import { registerListRoutes } from "./list.ts";
import { registerRunRoute } from "./run.ts";
import { registerSignalRoute } from "./signals.ts";
import { registerTransformRoute } from "./transform.ts";

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  // Order matters for Hono middleware: register the run-side first so
  // its `/v1/executions` middleware runs before list-side handlers
  // resolve. Transform / cancel / signals scope independently by path.
  registerRunRoute(app);
  registerTransformRoute(app);
  registerListRoutes(app);
  registerCancelRoute(app);
  registerSignalRoute(app);
}
