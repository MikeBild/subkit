// Notifications HTTP surface — entry point.
//
// Phase 4 of the 2026-05 architecture audit (issue #92). The former
// http/routes/notifications.ts (771 LOC) split into three sub-resource
// modules — channels, rules, deliveries. Public API is unchanged: the
// engine's server.ts still calls `registerNotificationRoutes(app)`,
// which delegates to the three sub-files.

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";
import { registerChannelRoutes } from "./channels.ts";
import { registerDeliveryRoutes } from "./deliveries.ts";
import { registerRuleRoutes } from "./rules.ts";

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>): void {
  registerChannelRoutes(app);
  registerRuleRoutes(app);
  registerDeliveryRoutes(app);
}
