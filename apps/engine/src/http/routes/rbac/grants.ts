// Resource-grant endpoints:
//   GET    /v1/rbac/grants
//   POST   /v1/rbac/grants
//   DELETE /v1/rbac/grants/:id

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as grantsSvc from "../../../rbac/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { RbacGrantSchema, serializeGrant } from "./shared.ts";

const listGrantsRoute = createRoute({
  method: "get",
  path: "/v1/rbac/grants",
  tags: ["rbac"],
  summary: "List resource grants",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(RbacGrantSchema) }).openapi("RbacGrantListResponse"),
        },
      },
    },
  },
});

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

const deleteGrantRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/grants/{id}",
  tags: ["rbac"],
  summary: "Revoke a resource grant",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Revoked" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerGrantsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/rbac/grants", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("rbac:read")(c, next);
    if (c.req.method === "POST") return requirePermission("rbac:write")(c, next);
    return next();
  });

  app.use("/v1/rbac/grants/:id", async (c, next) => {
    if (c.req.method !== "DELETE") return next();
    return requirePermission("rbac:write")(c, next);
  });

  app.openapi(listGrantsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await grantsSvc.listGrants(db, principal.tenant_id);
    return c.json({ items: items.map(serializeGrant) }, 200);
  });

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
      // Application-state error: the permission name is not in the
      // catalog. Stays a hand-rolled 400 — schema validation cannot
      // know the catalog contents.
      if ((err as Error).message?.startsWith("permission_unknown:")) {
        throw new BadRequestError((err as Error).message);
      }
      throw err as Error;
    }
  });

  app.openapi(deleteGrantRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const ok = await grantsSvc.revokeResource(db, principal.tenant_id, id);
    if (!ok) throw new NotFoundError("grant");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GRANT_REVOKED,
        resource_type: "resource_grant",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
    return c.body(null, 204);
  });
}
