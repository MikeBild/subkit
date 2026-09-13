// Permissions catalog endpoint:
//   GET /v1/rbac/permissions

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { loadPermissionCatalog } from "../../../rbac/index.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { PermissionCatalogEntrySchema } from "./shared.ts";

const listPermissionsRoute = createRoute({
  method: "get",
  path: "/v1/rbac/permissions",
  tags: ["rbac"],
  summary: "List the permission catalog",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({ items: z.array(PermissionCatalogEntrySchema) })
            .openapi("RbacPermissionListResponse"),
        },
      },
    },
  },
});

export function registerPermissionsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/rbac/permissions", async (c, next) => {
    if (c.req.method !== "GET") return next();
    return requirePermission("rbac:read")(c, next);
  });

  app.openapi(listPermissionsRoute, async (c) => {
    requireAuth(c);
    const catalog = loadPermissionCatalog();
    return c.json({ items: catalog.map((p) => ({ ...p })) }, 200);
  });
}
