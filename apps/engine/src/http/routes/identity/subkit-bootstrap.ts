import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { subkitBootstrapOperation } from "../../../api/operations/identity-self.ts";
import type { AppEnv } from "../../openapi.ts";

export { enforceTenantMatch } from "../../../api/operations/identity-self.ts";

export function registerSkBootstrapRoute(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, subkitBootstrapOperation);
}
