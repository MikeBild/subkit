import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../../openapi.ts";
import { registerCanRoutes } from "./can.ts";
import { registerGrantsRoutes } from "./grants.ts";
import { registerGroupsRoutes } from "./groups.ts";
import { registerPermissionsRoutes } from "./permissions.ts";
import { registerRolesRoutes } from "./roles.ts";

export function registerRbacRoutes(app: OpenAPIHono<AppEnv>): void {
  registerPermissionsRoutes(app);
  registerRolesRoutes(app);
  registerGrantsRoutes(app);
  registerGroupsRoutes(app);
  registerCanRoutes(app);
}
