// RBAC management API.
//
// All mutations write an audit row. All mutations require
// `rbac:write`. Listing + `can` queries require `rbac:read`.
// Built-in roles are read-only; mutating them returns 409 with code
// `builtin_role_immutable`.
//
// Routes:
//
//   GET    /v1/rbac/permissions
//   GET    /v1/rbac/roles
//   POST   /v1/rbac/roles
//   PATCH  /v1/rbac/roles/:id
//   DELETE /v1/rbac/roles/:id
//   POST   /v1/rbac/roles/:id/permissions
//   DELETE /v1/rbac/roles/:id/permissions/:permission
//   POST   /v1/rbac/users/:user_id/role
//   GET    /v1/rbac/grants
//   POST   /v1/rbac/grants
//   DELETE /v1/rbac/grants/:id
//   GET    /v1/rbac/groups
//   POST   /v1/rbac/groups
//   PATCH  /v1/rbac/groups/:id
//   DELETE /v1/rbac/groups/:id
//   POST   /v1/rbac/groups/:id/members/:user_id
//   DELETE /v1/rbac/groups/:id/members/:user_id
//   POST   /v1/rbac/groups/:id/roles/:role_id
//   DELETE /v1/rbac/groups/:id/roles/:role_id
//   POST   /v1/rbac/can
//
// The route file uses plain Hono handlers (no @hono/zod-openapi) so
// it can stay compact and wire through the permission middleware
// without ceremony.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { users as usersTable } from "../../db/schema/index.ts";
import { loadPermissionCatalog } from "../../rbac/catalog.ts";
import { can, type PermissionCheck } from "../../rbac/evaluator.ts";
import * as grantsSvc from "../../rbac/grants.ts";
import * as groupsSvc from "../../rbac/groups.ts";
import * as rolesSvc from "../../rbac/roles.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

function serializeRole(r: rolesSvc.RoleRow) {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    is_builtin: r.is_builtin,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}

function serializeGrant(g: grantsSvc.GrantRow) {
  return {
    id: g.id,
    tenant_id: g.tenant_id,
    subject_type: g.subject_type,
    subject_id: g.subject_id,
    resource_type: g.resource_type,
    resource_id: g.resource_id,
    permission_id: g.permission_id,
    permission: g.permission_name,
    granted_by: g.granted_by,
    created_at: g.created_at.toISOString(),
    expires_at: g.expires_at ? g.expires_at.toISOString() : null,
  };
}

function serializeGroup(g: groupsSvc.GroupRow) {
  return {
    id: g.id,
    tenant_id: g.tenant_id,
    name: g.name,
    description: g.description,
    created_at: g.created_at.toISOString(),
    updated_at: g.updated_at.toISOString(),
  };
}

function mapRoleError(err: unknown): never {
  if (err instanceof rolesSvc.BuiltinImmutableError) {
    throw new ConflictError("builtin_role_immutable");
  }
  if (err instanceof rolesSvc.RoleNotFoundError) {
    throw new NotFoundError("role");
  }
  if (err instanceof rolesSvc.PermissionNotFoundError) {
    throw new BadRequestError(err.message);
  }
  throw err as Error;
}

export function registerRbacRoutes(app: OpenAPIHono<AppEnv>): void {
  // ----- permissions catalog -----
  app.get("/v1/rbac/permissions", requirePermission("rbac:read"), async (c) => {
    requireAuth(c);
    const catalog = loadPermissionCatalog();
    return c.json({ items: catalog.map((p) => ({ ...p })) });
  });

  // ----- roles -----
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

  // ----- resource grants -----
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

  // ----- groups -----
  app.get("/v1/rbac/groups", requirePermission("rbac:read"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await groupsSvc.listGroups(db, principal.tenant_id);
    return c.json({ items: items.map(serializeGroup) });
  });

  app.post("/v1/rbac/groups", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = (await c.req.json()) as { name?: string; description?: string };
    if (!body.name) throw new BadRequestError("name required");
    const group = await groupsSvc.createGroup(db, principal.tenant_id, body.name, body.description);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_CREATED,
        resource_type: "group",
        resource_id: group.id,
        result: "success",
        metadata: { name: group.name },
      },
      db,
    );
    return c.json(serializeGroup(group), 201);
  });

  app.patch("/v1/rbac/groups/:id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const body = (await c.req.json()) as { name?: string; description?: string | null };
    const group = await groupsSvc.updateGroup(db, principal.tenant_id, id, body);
    if (!group) throw new NotFoundError("group");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_UPDATED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: { patch: body },
      },
      db,
    );
    return c.json(serializeGroup(group));
  });

  app.delete("/v1/rbac/groups/:id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const ok = await groupsSvc.deleteGroup(db, principal.tenant_id, id);
    if (!ok) throw new NotFoundError("group");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_DELETED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: {},
      },
      db,
    );
    return c.body(null, 204);
  });

  app.post("/v1/rbac/groups/:id/members/:user_id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const user_id = c.req.param("user_id");
    const group = await groupsSvc.getGroup(db, principal.tenant_id, id);
    if (!group) throw new NotFoundError("group");
    await groupsSvc.addMember(db, id, user_id, principal.id);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_MEMBER_ADDED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: { user_id },
      },
      db,
    );
    return c.json({ ok: true });
  });

  app.delete("/v1/rbac/groups/:id/members/:user_id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const user_id = c.req.param("user_id");
    const ok = await groupsSvc.removeMember(db, id, user_id);
    if (!ok) throw new NotFoundError("member");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_MEMBER_REMOVED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: { user_id },
      },
      db,
    );
    return c.body(null, 204);
  });

  app.post("/v1/rbac/groups/:id/roles/:role_id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const role_id = c.req.param("role_id");
    const group = await groupsSvc.getGroup(db, principal.tenant_id, id);
    if (!group) throw new NotFoundError("group");
    const role = await rolesSvc.getRole(db, principal.tenant_id, role_id);
    if (!role) throw new NotFoundError("role");
    await groupsSvc.assignRoleToGroup(db, id, role_id);
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_ROLE_ASSIGNED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: { role_id },
      },
      db,
    );
    return c.json({ ok: true });
  });

  app.delete("/v1/rbac/groups/:id/roles/:role_id", requirePermission("rbac:write"), async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    const role_id = c.req.param("role_id");
    const ok = await groupsSvc.revokeRoleFromGroup(db, id, role_id);
    if (!ok) throw new NotFoundError("group_role");
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.RBAC_GROUP_ROLE_REVOKED,
        resource_type: "group",
        resource_id: id,
        result: "success",
        metadata: { role_id },
      },
      db,
    );
    return c.body(null, 204);
  });

  // ----- can query -----
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
  void ForbiddenError;
}

async function buildQueryPrincipal(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<{
  provider: string;
  kind: "user" | "system_account";
  id: string;
  tenant_id: string;
  roles: string[];
} | null> {
  const { roles: rolesTable, systemAccounts } = await import("../../db/schema/index.ts");
  // Try user first.
  const uRows = await db
    .select({ id: usersTable.id, role: usersTable.role, role_name: rolesTable.name })
    .from(usersTable)
    .leftJoin(rolesTable, eq(rolesTable.id, usersTable.role_id))
    .where(and(eq(usersTable.id, id), eq(usersTable.tenant_id, tenant_id)))
    .limit(1);
  if (uRows[0]) {
    return {
      provider: "rbac_query",
      kind: "user",
      id,
      tenant_id,
      roles: [uRows[0].role_name ?? uRows[0].role],
    };
  }
  // Fall back to system account.
  const sRows = await db
    .select({
      id: systemAccounts.id,
      role_name: rolesTable.name,
    })
    .from(systemAccounts)
    .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
    .where(and(eq(systemAccounts.id, id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  if (sRows[0]) {
    return {
      provider: "rbac_query",
      kind: "system_account",
      id,
      tenant_id,
      roles: [sRows[0].role_name ?? "member"],
    };
  }
  return null;
}
