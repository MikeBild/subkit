import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  cancelExecutionOperation,
  getExecutionCostOperation,
  getExecutionOperation,
  getSensitiveExecutionResultOperation,
  listExecutionStepsOperation,
  listExecutionsOperation,
} from "../../../api/operations/executions.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";
import { registerRerunRoute } from "./rerun.ts";
import { registerRunRoute } from "./run.ts";
import { registerSignalRoute } from "./signals.ts";
import { registerExecutionStreamRoute } from "./stream.ts";
import { registerTransformRoute } from "./transform.ts";

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  registerRunRoute(app);
  registerTransformRoute(app);
  registerRerunRoute(app);
  toHonoRoute(app, listExecutionsOperation);
  toHonoRoute(app, getExecutionOperation);
  toHonoRoute(app, listExecutionStepsOperation);
  toHonoRoute(app, getSensitiveExecutionResultOperation);
  registerExecutionStreamRoute(app);
  toHonoRoute(app, getExecutionCostOperation);
  toHonoRoute(app, cancelExecutionOperation);
  registerSignalRoute(app);
}
