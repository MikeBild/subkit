import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  assignUserRoleOperation,
  createRoleOperation,
  deleteRoleOperation,
  getRoleOperation,
  grantRolePermissionOperation,
  listRolesOperation,
  revokeRolePermissionOperation,
  updateRoleOperation,
} from "../../../api/operations/rbac.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerRolesRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listRolesOperation);
  toHonoRoute(app, getRoleOperation);
  toHonoRoute(app, createRoleOperation);
  toHonoRoute(app, updateRoleOperation);
  toHonoRoute(app, deleteRoleOperation);
  toHonoRoute(app, grantRolePermissionOperation);
  toHonoRoute(app, revokeRolePermissionOperation);
  toHonoRoute(app, assignUserRoleOperation);
}
