import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  createSubscriptionOperation,
  deleteSubscriptionOperation,
  getSubscriptionOperation,
  listSubscriptionsOperation,
  replaySubscriptionDeliveryOperation,
  updateSubscriptionOperation,
} from "../../api/operations/subscriptions.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

export function registerSubscriptionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/subscriptions/:id/deliveries/:delivery_id/replay", async (c, next) => {
    if (c.req.method === "POST") return next();
    const id = c.req.param("id");
    return requirePermission("subscription:replay", () => ({ type: "subscription", id }))(c, next);
  });

  toHonoRoute(app, listSubscriptionsOperation);
  toHonoRoute(app, getSubscriptionOperation);
  toHonoRoute(app, createSubscriptionOperation);
  toHonoRoute(app, updateSubscriptionOperation);
  toHonoRoute(app, deleteSubscriptionOperation);
  toHonoRoute(app, replaySubscriptionDeliveryOperation);
}
