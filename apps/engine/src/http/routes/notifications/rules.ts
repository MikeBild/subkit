import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createNotificationRuleOperation,
  deleteNotificationRuleOperation,
  listNotificationRulesOperation,
  testNotificationRuleOperation,
  updateNotificationRuleOperation,
} from "../../../api/operations/notification-rules.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerRuleRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listNotificationRulesOperation);
  toHonoRoute(app, createNotificationRuleOperation);
  toHonoRoute(app, updateNotificationRuleOperation);
  toHonoRoute(app, deleteNotificationRuleOperation);
  toHonoRoute(app, testNotificationRuleOperation);
}
