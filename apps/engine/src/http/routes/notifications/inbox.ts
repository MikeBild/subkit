import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  ackNotificationInboxOperation,
  listNotificationInboxOperation,
  markNotificationInboxReadOperation,
  markNotificationInboxUnreadOperation,
} from "../../../api/operations/notification-inbox.ts";
import { gateOtherMethods, requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerInboxRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(
    "/v1/notifications/inbox",
    gateOtherMethods(["GET", "HEAD"], requirePermission("notification:read")),
  );
  app.use(
    "/v1/notifications/inbox/ack",
    gateOtherMethods(["POST"], requirePermission("notification:read")),
  );
  app.use(
    "/v1/notifications/inbox/read",
    gateOtherMethods(["POST"], requirePermission("notification:read")),
  );
  app.use(
    "/v1/notifications/inbox/unread",
    gateOtherMethods(["POST"], requirePermission("notification:read")),
  );

  toHonoRoute(app, listNotificationInboxOperation);
  toHonoRoute(app, ackNotificationInboxOperation);
  toHonoRoute(app, markNotificationInboxReadOperation);
  toHonoRoute(app, markNotificationInboxUnreadOperation);
}
