// Group CRUD + member management + group-role assignment:
//   GET    /v1/rbac/groups
//   POST   /v1/rbac/groups
//   PATCH  /v1/rbac/groups/:id
//   DELETE /v1/rbac/groups/:id
//   POST   /v1/rbac/groups/:id/members/:user_id
//   DELETE /v1/rbac/groups/:id/members/:user_id
//   POST   /v1/rbac/groups/:id/roles/:role_id
//   DELETE /v1/rbac/groups/:id/roles/:role_id

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as groupsSvc from "../../../rbac/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { RbacGroupSchema, serializeGroup } from "./shared.ts";

const GroupMemberParams = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
});

const GroupRoleParams = z.object({
  id: z.string().uuid(),
  role_id: z.string().uuid(),
});

const OkResponse = z.object({ ok: z.literal(true) });

const listGroupsRoute = createRoute({
  method: "get",
  path: "/v1/rbac/groups",
  tags: ["rbac"],
  summary: "List groups",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(RbacGroupSchema) }).openapi("RbacGroupListResponse"),
        },
      },
    },
  },
});

const createGroupRoute = createRoute({
  method: "post",
  path: "/v1/rbac/groups",
  tags: ["rbac"],
  summary: "Create a group",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({ name: z.string(), description: z.string().optional() })
            .openapi("CreateRbacGroupRequest"),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RbacGroupSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchGroupRoute = createRoute({
  method: "patch",
  path: "/v1/rbac/groups/{id}",
  tags: ["rbac"],
  summary: "Update a group",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().optional(),
              description: z.string().nullable().optional(),
            })
            .openapi("UpdateRbacGroupRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RbacGroupSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteGroupRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/groups/{id}",
  tags: ["rbac"],
  summary: "Delete a group",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/v1/rbac/groups/{id}/members/{user_id}",
  tags: ["rbac"],
  summary: "Add a user to a group",
  security: [{ bearerAuth: [] }],
  request: { params: GroupMemberParams },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/groups/{id}/members/{user_id}",
  tags: ["rbac"],
  summary: "Remove a user from a group",
  security: [{ bearerAuth: [] }],
  request: { params: GroupMemberParams },
  responses: {
    204: { description: "Removed" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const assignGroupRoleRoute = createRoute({
  method: "post",
  path: "/v1/rbac/groups/{id}/roles/{role_id}",
  tags: ["rbac"],
  summary: "Assign a role to a group",
  security: [{ bearerAuth: [] }],
  request: { params: GroupRoleParams },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: OkResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeGroupRoleRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/groups/{id}/roles/{role_id}",
  tags: ["rbac"],
  summary: "Revoke a role from a group",
  security: [{ bearerAuth: [] }],
  request: { params: GroupRoleParams },
  responses: {
    204: { description: "Revoked" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerGroupsRoutes(app: OpenAPIHono<AppEnv>): void {
  const write = requirePermission("rbac:write");

  app.use("/v1/rbac/groups", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("rbac:read")(c, next);
    if (c.req.method === "POST") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/groups/:id", async (c, next) => {
    if (c.req.method === "PATCH" || c.req.method === "DELETE") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/groups/:id/members/:user_id", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "DELETE") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/groups/:id/roles/:role_id", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "DELETE") return write(c, next);
    return next();
  });

  app.openapi(listGroupsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await groupsSvc.listGroups(db, principal.tenant_id);
    return c.json({ items: items.map(serializeGroup) }, 200);
  });

  app.openapi(createGroupRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
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

  app.openapi(patchGroupRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const patch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
    const group = await groupsSvc.updateGroup(db, principal.tenant_id, id, patch);
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
    return c.json(serializeGroup(group), 200);
  });

  app.openapi(deleteGroupRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
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

  app.openapi(addMemberRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, user_id } = c.req.valid("param");
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
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(removeMemberRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, user_id } = c.req.valid("param");
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

  app.openapi(assignGroupRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, role_id } = c.req.valid("param");
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
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(revokeGroupRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, role_id } = c.req.valid("param");
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
