import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  addGroupMemberOperation,
  assignGroupRoleOperation,
  createGroupOperation,
  deleteGroupOperation,
  listGroupsOperation,
  removeGroupMemberOperation,
  revokeGroupRoleOperation,
  updateGroupOperation,
} from "../../../api/operations/rbac.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerGroupsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listGroupsOperation);
  toHonoRoute(app, createGroupOperation);
  toHonoRoute(app, updateGroupOperation);
  toHonoRoute(app, deleteGroupOperation);
  toHonoRoute(app, addGroupMemberOperation);
  toHonoRoute(app, removeGroupMemberOperation);
  toHonoRoute(app, assignGroupRoleOperation);
  toHonoRoute(app, revokeGroupRoleOperation);
}
