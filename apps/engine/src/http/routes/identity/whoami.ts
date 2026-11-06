import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { whoamiOperation } from "../../../api/operations/identity-self.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerWhoamiRoute(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, whoamiOperation);
}
