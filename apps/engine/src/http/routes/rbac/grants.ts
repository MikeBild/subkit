import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import { deleteGrantOperation, listGrantsOperation } from "../../../api/operations/rbac.ts";
import { RbacGrantSchema, serializeGrant } from "../../../api/operations/rbac-representation.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as grantsSvc from "../../../rbac/index.ts";
import { BadRequestError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const createGrantRoute = createRoute({
  method: "post",
  path: "/v1/rbac/grants",
  tags: ["rbac"],
  summary: "Create a resource grant",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              subject_type: z.enum(["user", "system_account", "group"]),
              subject_id: z.string(),
              resource_type: z.string(),
              resource_id: z.string(),
              permission: z.string(),
              expires_at: z.string().nullable().optional(),
            })
            .openapi("CreateRbacGrantRequest"),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: RbacGrantSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerGrantsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/rbac/grants", async (c, next) => {
    if (c.req.method === "POST") return requirePermission("rbac:write")(c, next);
    return next();
  });

  toHonoRoute(app, listGrantsOperation);

  app.openapi(createGrantRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    try {
      const grant = await grantsSvc.grantResource(db, {
        tenant_id: principal.tenant_id,
        subject_type: body.subject_type,
        subject_id: body.subject_id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        permission: body.permission,
        granted_by: principal.id,
        expires_at: body.expires_at ? new Date(body.expires_at) : null,
      });
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.RBAC_GRANT_CREATED,
          resource_type: "resource_grant",
          resource_id: grant.id,
          result: "success",
          metadata: {
            subject_type: grant.subject_type,
            subject_id: grant.subject_id,
            permission: grant.permission_name,
            resource_type: grant.resource_type,
            resource_id: grant.resource_id,
          },
        },
        db,
      );
      return c.json(serializeGrant(grant), 201);
    } catch (err) {
      if ((err as Error).message?.startsWith("permission_unknown:")) {
        throw new BadRequestError((err as Error).message);
      }
      throw err as Error;
    }
  });

  toHonoRoute(app, deleteGrantOperation);
}
