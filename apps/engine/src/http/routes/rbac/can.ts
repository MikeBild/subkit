// Permission-check endpoint:
//   POST /v1/rbac/can

import type { OpenAPIHono } from "@hono/zod-openapi";
import { can, type PermissionCheck } from "../../../rbac/evaluator.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { buildQueryPrincipal } from "./shared.ts";

export function registerCanRoutes(app: OpenAPIHono<AppEnv>): void {
  app.post("/v1/rbac/can", requirePermission("rbac:read"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = (await c.req.json()) as {
      principal_id?: string;
      permission?: string;
      resource?: { type: string; id: string };
    };
    if (!body.principal_id || !body.permission) {
      throw new BadRequestError("principal_id + permission required");
    }
    // Build a synthetic principal to query. For simplicity we look
    // up the user row and use its role. Custom roles are honored
    // because the api-key provider now reads rolesTable.name.
    const queryPrincipal = await buildQueryPrincipal(db, principal.tenant_id, body.principal_id);
    if (!queryPrincipal) throw new NotFoundError("principal");
    const check: PermissionCheck = {
      tenant_id: principal.tenant_id,
      principal: queryPrincipal,
      permission: body.permission,
      ...(body.resource ? { resource: body.resource } : {}),
    };
    const decision = await can(db, check);
    return c.json({
      allow: decision.allow,
      reason: decision.reason ?? null,
      source: decision.source ?? null,
    });
  });
}
