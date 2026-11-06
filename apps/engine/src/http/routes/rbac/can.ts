import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { canOperation } from "../../../api/operations/rbac.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerCanRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, canOperation);
}
