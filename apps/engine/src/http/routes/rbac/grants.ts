// Resource-grant endpoints:
//   GET    /v1/rbac/grants
//   POST   /v1/rbac/grants
//   DELETE /v1/rbac/grants/:id

import type { OpenAPIHono } from "@hono/zod-openapi";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import * as grantsSvc from "../../../rbac/grants.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { serializeGrant } from "./shared.ts";

export function registerGrantsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/rbac/grants", requirePermission("rbac:read"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await grantsSvc.listGrants(db, principal.tenant_id);
    return c.json({ items: items.map(serializeGrant) });
  });

  app.post("/v1/rbac/grants", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = (await c.req.json()) as {
      subject_type?: grantsSvc.GrantSubjectType;
      subject_id?: string;
      resource_type?: string;
      resource_id?: string;
      permission?: string;
      expires_at?: string | null;
    };
    if (
      !body.subject_type ||
      !body.subject_id ||
      !body.resource_type ||
      !body.resource_id ||
      !body.permission
    ) {
      throw new BadRequestError("subject, resource, permission required");
    }
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

  app.delete("/v1/rbac/grants/:id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
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
