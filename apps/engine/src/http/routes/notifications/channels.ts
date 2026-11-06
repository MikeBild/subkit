import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createNotificationChannelOperation,
  deleteNotificationChannelOperation,
  listNotificationChannelsOperation,
  updateNotificationChannelOperation,
} from "../../../api/operations/notification-channels.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerChannelRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listNotificationChannelsOperation);
  toHonoRoute(app, createNotificationChannelOperation);
  toHonoRoute(app, updateNotificationChannelOperation);
  toHonoRoute(app, deleteNotificationChannelOperation);
}
