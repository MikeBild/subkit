// Group CRUD + member management + group-role assignment:
//   GET    /v1/rbac/groups
//   POST   /v1/rbac/groups
//   PATCH  /v1/rbac/groups/:id
//   DELETE /v1/rbac/groups/:id
//   POST   /v1/rbac/groups/:id/members/:user_id
//   DELETE /v1/rbac/groups/:id/members/:user_id
//   POST   /v1/rbac/groups/:id/roles/:role_id
//   DELETE /v1/rbac/groups/:id/roles/:role_id

import type { OpenAPIHono } from "@hono/zod-openapi";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as groupsSvc from "../../../rbac/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { BadRequestError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { serializeGroup } from "./shared.ts";

export function registerGroupsRoutes(app: OpenAPIHono<AppEnv>): void {
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
}
