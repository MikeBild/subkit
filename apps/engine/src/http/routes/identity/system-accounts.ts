import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createSystemAccountOperation,
  deleteSystemAccountOperation,
  listSystemAccountsOperation,
} from "../../../api/operations/identity-credentials.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerSystemAccountRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listSystemAccountsOperation);
  toHonoRoute(app, createSystemAccountOperation);
  toHonoRoute(app, deleteSystemAccountOperation);
}
