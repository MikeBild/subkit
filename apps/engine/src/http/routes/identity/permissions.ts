import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { effectivePermissionsOperation } from "../../../api/operations/identity-self.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerEffectivePermissionsRoute(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, effectivePermissionsOperation);
}
