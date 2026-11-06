import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { listNotificationDeliveriesOperation } from "../../../api/operations/notification-deliveries.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerDeliveryRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listNotificationDeliveriesOperation);
}
