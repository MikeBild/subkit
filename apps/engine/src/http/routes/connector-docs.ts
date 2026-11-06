import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  deleteConnectorDocOperation,
  ingestConnectorDocsOperation,
  listConnectorDocsOperation,
  searchConnectorDocsOperation,
} from "../../api/operations/connector-docs.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import type { AppEnv } from "../openapi.ts";

export function registerConnectorDocsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, ingestConnectorDocsOperation);
  toHonoRoute(app, listConnectorDocsOperation);
  toHonoRoute(app, searchConnectorDocsOperation);
  toHonoRoute(app, deleteConnectorDocOperation);
}
