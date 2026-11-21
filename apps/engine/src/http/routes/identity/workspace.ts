import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { getSetupOperation, putSetupOperation } from "../../../api/operations/identity-setup.ts";
import {
  updateOwnProfileOperation,
  updateWorkspaceOperation,
} from "../../../api/operations/identity-workspace.ts";
import {
  getNotificationPauseOperation,
  pauseNotificationsOperation,
  resumeNotificationsOperation,
} from "../../../api/operations/notification-pause.ts";
import { setWorkspaceAiAccessOperation } from "../../../api/operations/workspace-ai-access.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerWorkspaceRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, updateOwnProfileOperation);
  toHonoRoute(app, getSetupOperation);
  toHonoRoute(app, putSetupOperation);
  toHonoRoute(app, getNotificationPauseOperation);
  toHonoRoute(app, pauseNotificationsOperation);
  toHonoRoute(app, resumeNotificationsOperation);
  toHonoRoute(app, updateWorkspaceOperation);
  toHonoRoute(app, setWorkspaceAiAccessOperation);
}
