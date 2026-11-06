import type { OpenAPIHono } from "@hono/zod-openapi";
import { conversationLifecycleOperations } from "../../../api/operations/conversation-lifecycle.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import * as svc from "../../../conversations/index.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerLifecycleRoutes(app: OpenAPIHono<AppEnv>): void {
  const operations = conversationLifecycleOperations(svc);
  toHonoRoute(app, operations.cancel);
  toHonoRoute(app, operations.remove);
  toHonoRoute(app, operations.hide);
  toHonoRoute(app, operations.unhide);
  toHonoRoute(app, operations.contextSnapshot);
  toHonoRoute(app, operations.compact);
  toHonoRoute(app, operations.fork);
}
