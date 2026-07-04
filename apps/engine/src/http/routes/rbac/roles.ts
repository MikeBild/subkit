// Role CRUD + role-permission management + user-role assignment:
//   GET    /v1/rbac/roles
//   GET    /v1/rbac/roles/:id
//   POST   /v1/rbac/roles
//   PATCH  /v1/rbac/roles/:id
//   DELETE /v1/rbac/roles/:id
//   POST   /v1/rbac/roles/:id/permissions
//   DELETE /v1/rbac/roles/:id/permissions/:permission
//   POST   /v1/rbac/users/:user_id/role

import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import { users as usersTable } from "../../../db/schema/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { mapRoleError, serializeRole } from "./shared.ts";

export function registerRolesRoutes(app: OpenAPIHono<AppEnv>): void {
  app.get("/v1/rbac/roles", requirePermission("rbac:read"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await rolesSvc.listRoles(db, principal.tenant_id);
    return c.json({ items: items.map(serializeRole) });
  });

  app.get("/v1/rbac/roles/:id", requirePermission("rbac:read"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const role = await rolesSvc.getRole(db, principal.tenant_id, id);
    if (!role) throw new NotFoundError("role");
    const perms = await rolesSvc.listRolePermissions(db, role.id);
    return c.json({ ...serializeRole(role), permissions: perms });
  });

  app.post("/v1/rbac/roles", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = (await c.req.json()) as { name?: string; description?: string };
    if (!body.name) throw new BadRequestError("name required");
    const role = await rolesSvc.createRole(db, principal.tenant_id, body.name, body.description);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_ROLE_CREATED,
        resource_type: "role",
        resource_id: role.id,
        result: "success",
        metadata: { name: role.name },
      },
      db,
    );
    return c.json(serializeRole(role), 201);
  });

  app.patch("/v1/rbac/roles/:id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const body = (await c.req.json()) as { name?: string; description?: string | null };
    let role: rolesSvc.RoleRow;
    try {
      role = await rolesSvc.updateRole(db, principal.tenant_id, id, body);
    } catch (err) {
      mapRoleError(err);
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_ROLE_UPDATED,
        resource_type: "role",
        resource_id: role.id,
        result: "success",
        metadata: { patch: body },
      },
      db,
    );
    return c.json(serializeRole(role));
  });

  app.delete("/v1/rbac/roles/:id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    try {
      await rolesSvc.deleteRole(db, principal.tenant_id, id);
    } catch (err) {
      mapRoleError(err);
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_ROLE_DELETED,
        resource_type: "role",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
    return c.body(null, 204);
  });

  app.post("/v1/rbac/roles/:id/permissions", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const body = (await c.req.json()) as { permission?: string };
    if (!body.permission) throw new BadRequestError("permission required");
    try {
      await rolesSvc.grantPermissionToRole(db, principal.tenant_id, id, body.permission);
    } catch (err) {
      mapRoleError(err);
    }
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_ROLE_PERMISSION_GRANTED,
        resource_type: "role",
        resource_id: id,
        result: "success",
        metadata: { permission: body.permission },
      },
      db,
    );
    return c.json({ ok: true });
  });

  app.delete(
    "/v1/rbac/roles/:id/permissions/:permission",
    requirePermission("rbac:write"),
    async (c) => {
      const principal = requireAuth(c);
      const db = c.get("db");
      const id = c.req.param("id");
      const permission = c.req.param("permission");
      try {
        await rolesSvc.revokePermissionFromRole(db, principal.tenant_id, id, permission);
      } catch (err) {
        mapRoleError(err);
      }
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.RBAC_ROLE_PERMISSION_REVOKED,
          resource_type: "role",
          resource_id: id,
          result: "success",
          metadata: { permission },
        },
        db,
      );
      return c.body(null, 204);
    },
  );

  // ----- user role assignment -----
  app.post("/v1/rbac/users/:user_id/role", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const user_id = c.req.param("user_id");
    const body = (await c.req.json()) as { role_id?: string | null };
    // Validate the role belongs to this tenant or is a built-in.
    if (body.role_id) {
      const role = await rolesSvc.getRole(db, principal.tenant_id, body.role_id);
      if (!role) throw new BadRequestError("role_id not found");
    }
    const rows = await db
      .update(usersTable)
      .set({ role_id: body.role_id ?? null })
      .where(and(eq(usersTable.tenant_id, principal.tenant_id), eq(usersTable.id, user_id)))
      .returning({ id: usersTable.id });
    if (rows.length === 0) throw new NotFoundError("user");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: body.role_id
          ? AuditAction.RBAC_USER_ROLE_ASSIGNED
          : AuditAction.RBAC_USER_ROLE_REVOKED,
        resource_type: "user",
        resource_id: user_id,
        result: "success",
        metadata: { role_id: body.role_id ?? null },
      },
      db,
    );
    return c.json({ ok: true, user_id, role_id: body.role_id ?? null });
  });
}
