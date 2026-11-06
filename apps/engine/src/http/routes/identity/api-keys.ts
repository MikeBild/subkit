import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  issueApiKeyOperation,
  listApiKeysOperation,
  revokeApiKeyOperation,
  rotateApiKeyOperation,
} from "../../../api/operations/identity-credentials.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerApiKeyRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listApiKeysOperation);
  toHonoRoute(app, issueApiKeyOperation);
  toHonoRoute(app, rotateApiKeyOperation);
  toHonoRoute(app, revokeApiKeyOperation);
}
