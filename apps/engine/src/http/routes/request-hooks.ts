import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  createRequestHookOperation,
  deleteRequestHookOperation,
  listRequestHooksOperation,
  updateRequestHookOperation,
} from "../../api/operations/request-hooks.ts";
import type { AppEnv } from "../openapi.ts";

export function registerRequestHookRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listRequestHooksOperation);
  toHonoRoute(app, createRequestHookOperation);
  toHonoRoute(app, updateRequestHookOperation);
  toHonoRoute(app, deleteRequestHookOperation);
}
