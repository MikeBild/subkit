import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  cockpitPushOperations,
  type ResolveCockpitPushContext,
} from "../../api/operations/cockpit-push.ts";
import { toHonoRoute } from "../../api/operations/hono.ts";
import type { AppEnv } from "../openapi.ts";

export function registerCockpitPushRoutes(
  app: OpenAPIHono<AppEnv>,
  resolveContext: ResolveCockpitPushContext,
): void {
  const operations = cockpitPushOperations(resolveContext);
  toHonoRoute(app, operations.status);
  toHonoRoute(app, operations.prepare);
  toHonoRoute(app, operations.update);
  toHonoRoute(app, operations.remove);
}
