// Permissions catalog endpoint:
//   GET /v1/rbac/permissions

import type { OpenAPIHono } from "@hono/zod-openapi";
import { loadPermissionCatalog } from "../../../rbac/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

export function registerPermissionsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/rbac/permissions", requirePermission("rbac:read"), async (c) => {
    requireAuth(c);
    const catalog = loadPermissionCatalog();
    return c.json({ items: catalog.map((p) => ({ ...p })) });
  });
}
