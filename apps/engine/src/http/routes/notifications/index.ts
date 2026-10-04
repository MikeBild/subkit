import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";
import { registerChannelRoutes } from "./channels.ts";
import { registerDeliveryRoutes } from "./deliveries.ts";
import { registerInboxRoutes } from "./inbox.ts";
import { registerRuleRoutes } from "./rules.ts";

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>): void {
  registerChannelRoutes(app);
  registerRuleRoutes(app);
  registerDeliveryRoutes(app);
  registerInboxRoutes(app);
}
