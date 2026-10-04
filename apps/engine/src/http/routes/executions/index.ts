import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";
import { registerCancelRoute } from "./cancel.ts";
import { registerCostRoute } from "./cost.ts";
import { registerListRoutes } from "./list.ts";
import { registerRerunRoute } from "./rerun.ts";
import { registerRunRoute } from "./run.ts";
import { registerSignalRoute } from "./signals.ts";
import { registerTransformRoute } from "./transform.ts";

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  registerRunRoute(app);
  registerTransformRoute(app);
  registerRerunRoute(app);
  registerListRoutes(app);
  registerCostRoute(app);
  registerCancelRoute(app);
  registerSignalRoute(app);
}
