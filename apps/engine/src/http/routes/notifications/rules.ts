import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createNotificationRuleOperation,
  deleteNotificationRuleOperation,
  listNotificationRulesOperation,
  makeTestNotificationRuleOperation,
  updateNotificationRuleOperation,
} from "../../../api/operations/notification-rules.ts";
import type { ChatAdapterRegistry } from "../../../chat/index.ts";
import { makeRegistryAdapterResolver } from "../../../webhooks/index.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerRuleRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: { chatRegistry?: ChatAdapterRegistry } = {},
): void {
  toHonoRoute(app, listNotificationRulesOperation);
  toHonoRoute(app, createNotificationRuleOperation);
  toHonoRoute(app, updateNotificationRuleOperation);
  toHonoRoute(app, deleteNotificationRuleOperation);
  toHonoRoute(
    app,
    makeTestNotificationRuleOperation(
      deps.chatRegistry ? { resolveAdapter: makeRegistryAdapterResolver(deps.chatRegistry) } : {},
    ),
  );
}
