import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { listPermissionsOperation } from "../../../api/operations/rbac.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerPermissionsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listPermissionsOperation);
}
