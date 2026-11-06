import type { OpenAPIHono } from "@hono/zod-openapi";
import { toHonoRoute } from "../../api/operations/hono.ts";
import {
  getSettingOperation,
  listSettingsModelCatalogOperation,
  listSettingsOperation,
} from "../../api/operations/settings.ts";
import { putSettingOperation } from "../../api/operations/settings-write.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const HOSTED_SETTINGS_PATHS = [
  "/v1/settings/hosted-work/*",
  "/v1/settings/hosted-storage/*",
] as const;

export function registerSettingsRoutes(app: OpenAPIHono<AppEnv>): void {
  toHonoRoute(app, listSettingsOperation);
  toHonoRoute(app, listSettingsModelCatalogOperation);
  toHonoRoute(app, getSettingOperation);

  for (const prefix of HOSTED_SETTINGS_PATHS) {
    app.use(prefix, (c, next) =>
      c.req.method === "GET"
        ? requirePermission("settings:read")(c, next)
        : requirePermission("settings:write")(c, next),
    );
  }
  toHonoRoute(app, putSettingOperation);
}
