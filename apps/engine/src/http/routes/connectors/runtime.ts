import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  connectorRuntimeOperation,
  connectorToolConfirmationOperation,
} from "../../../api/operations/connectors-runtime.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerConnectorRuntimeRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, connectorRuntimeOperation);
  toHonoRoute(app, connectorToolConfirmationOperation);
}
