import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { buildQueryPrincipal, can, type PermissionCheck } from "../../../rbac/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { RbacCanResponseSchema } from "./shared.ts";

const canRoute = createRoute({
  method: "post",
  path: "/v1/rbac/can",
  tags: ["rbac"],
  summary: "Check whether a principal holds a permission",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              principal_id: z.string(),
              permission: z.string(),
              resource: z.object({ type: z.string(), id: z.string() }).optional(),
            })
            .openapi("RbacCanRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RbacCanResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCanRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/rbac/can", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("rbac:read")(c, next);
  });

  app.openapi(canRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const queryPrincipal = await buildQueryPrincipal(db, principal.tenant_id, body.principal_id);
    if (!queryPrincipal) throw new NotFoundError("principal");
    const check: PermissionCheck = {
      tenant_id: principal.tenant_id,
      principal: queryPrincipal,
      permission: body.permission,
      ...(body.resource ? { resource: body.resource } : {}),
    };
    const decision = await can(db, check);
    return c.json(
      {
        allow: decision.allow,
        reason: decision.reason ?? null,
        source: decision.source ?? null,
      },
      200,
    );
  });
}
