import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  getExecutionCostOperation,
  getExecutionOperation,
  listExecutionStepsOperation,
  listExecutionsOperation,
} from "../../../api/operations/executions.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerCancelRoute } from "./cancel.ts";
import { registerExecutionResultRoutes } from "./list.ts";
import { registerRerunRoute } from "./rerun.ts";
import { registerRunRoute } from "./run.ts";
import { registerSignalRoute } from "./signals.ts";
import { registerTransformRoute } from "./transform.ts";

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  registerRunRoute(app);
  registerTransformRoute(app);
  registerRerunRoute(app);
  toHonoRoute(app, listExecutionsOperation);
  toHonoRoute(app, getExecutionOperation);
  toHonoRoute(app, listExecutionStepsOperation);
  registerExecutionResultRoutes(app);
  toHonoRoute(app, getExecutionCostOperation);
  registerCancelRoute(app);
  registerSignalRoute(app);
}
