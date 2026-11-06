import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import { listSubscriptionDeliveriesOperation } from "../../api/operations/subscription-deliveries.ts";
import {
  createSubscriptionOperation,
  deleteSubscriptionOperation,
  getSubscriptionOperation,
  listSubscriptionsOperation,
  replaySubscriptionDeliveryOperation,
  updateSubscriptionOperation,
} from "../../api/operations/subscriptions.ts";
import { gateOtherMethods, requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSubscriptionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/subscriptions/:id/deliveries/:delivery_id/replay",
    gateOtherMethods(
      ["POST"],
      requirePermission("subscription:replay", (c) => ({
        type: "subscription",
        id: c.req.param("id") ?? "",
      })),
    ),
  );

  toHonoRoute(app, listSubscriptionsOperation);
  toHonoRoute(app, getSubscriptionOperation);
  toHonoRoute(app, createSubscriptionOperation);
  toHonoRoute(app, updateSubscriptionOperation);
  toHonoRoute(app, deleteSubscriptionOperation);
  toHonoRoute(app, replaySubscriptionDeliveryOperation);
  toHonoRoute(app, listSubscriptionDeliveriesOperation);
}
