import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  createGrantOperation,
  deleteGrantOperation,
  listGrantsOperation,
} from "../../../api/operations/rbac.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerGrantsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listGrantsOperation);
  toHonoRoute(app, createGrantOperation);
  toHonoRoute(app, deleteGrantOperation);
}
