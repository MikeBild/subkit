import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createUserOperation,
  deactivateUserOperation,
  getUserOperation,
  listUsersOperation,
  updateUserOperation,
} from "../../../api/operations/identity-users.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerUserRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listUsersOperation);
  toHonoRoute(app, getUserOperation);
  toHonoRoute(app, createUserOperation);
  toHonoRoute(app, updateUserOperation);
  toHonoRoute(app, deactivateUserOperation);
}
