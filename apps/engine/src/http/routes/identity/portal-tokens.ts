import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  issuePortalTokenOperation,
  listPortalTokensOperation,
  revokePortalTokenOperation,
} from "../../../api/operations/identity-credentials.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerPortalTokenRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listPortalTokensOperation);
  toHonoRoute(app, issuePortalTokenOperation);
  toHonoRoute(app, revokePortalTokenOperation);
}
