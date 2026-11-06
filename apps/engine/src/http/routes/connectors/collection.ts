import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  createConnectorOperation,
  deleteConnectorOperation,
  disableConnectorOperation,
  enableConnectorOperation,
  getConnectorOperation,
  listConnectorsOperation,
  updateConnectorOperation,
} from "../../../api/operations/connectors.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerCollectionRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listConnectorsOperation);
  toHonoRoute(app, createConnectorOperation);
  toHonoRoute(app, getConnectorOperation);
  toHonoRoute(app, updateConnectorOperation);
  toHonoRoute(app, enableConnectorOperation);
  toHonoRoute(app, disableConnectorOperation);
  toHonoRoute(app, deleteConnectorOperation);
}
