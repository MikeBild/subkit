import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  getTenantOperation,
  listTenantsOperation,
} from "../../../api/operations/identity-users.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerTenantRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listTenantsOperation);
  toHonoRoute(app, getTenantOperation);
}
