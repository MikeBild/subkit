import type { OpenAPIHono } from "@hono/zod-openapi";
import { promoteConnectorOperation } from "../../../api/operations/connector-promotion.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerPromotionRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, promoteConnectorOperation);
}
