import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as identity from "../../../identity/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { BadRequestError, LastAdminConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { mapRoleError, RbacRoleDetailSchema, RbacRoleSchema, serializeRole } from "./shared.ts";

const RolePermissionParams = z.object({
  id: z.string().uuid(),
  permission: z.string(),
});

const UserIdParam = z.object({ user_id: z.string().uuid() });

const listRolesRoute = createRoute({
  method: "get",
  path: "/v1/rbac/roles",
  tags: ["rbac"],
  summary: "List roles",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({ items: z.array(RbacRoleDetailSchema) })
            .openapi("RbacRoleListResponse"),
        },
      },
    },
  },
});

const getRoleRoute = createRoute({
  method: "get",
  path: "/v1/rbac/roles/{id}",
  tags: ["rbac"],
  summary: "Get a role with its permissions",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RbacRoleDetailSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const createRoleRoute = createRoute({
  method: "post",
  path: "/v1/rbac/roles",
  tags: ["rbac"],
  summary: "Create a custom role",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({ name: z.string(), description: z.string().optional() })
            .openapi("CreateRbacRoleRequest"),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RbacRoleSchema } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const patchRoleRoute = createRoute({
  method: "patch",
  path: "/v1/rbac/roles/{id}",
  tags: ["rbac"],
  summary: "Update a custom role",
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
            .openapi("UpdateRbacRoleRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: RbacRoleSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const deleteRoleRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/roles/{id}",
  tags: ["rbac"],
  summary: "Delete a custom role",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    204: { description: "Deleted" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const grantRolePermissionRoute = createRoute({
  method: "post",
  path: "/v1/rbac/roles/{id}/permissions",
  tags: ["rbac"],
  summary: "Grant a permission to a role",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ permission: z.string() }).openapi("GrantRolePermissionRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const revokeRolePermissionRoute = createRoute({
  method: "delete",
  path: "/v1/rbac/roles/{id}/permissions/{permission}",
  tags: ["rbac"],
  summary: "Revoke a permission from a role",
  security: [{ bearerAuth: [] }],
  request: { params: RolePermissionParams },
  responses: {
    204: { description: "Revoked" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: { description: "Conflict", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const assignUserRoleRoute = createRoute({
  method: "post",
  path: "/v1/rbac/users/{user_id}/role",
  tags: ["rbac"],
  summary: "Assign a user's role",
  security: [{ bearerAuth: [] }],
  request: {
    params: UserIdParam,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ role_id: z.string() }).openapi("AssignUserRoleRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z
            .object({
              ok: z.literal(true),
              user_id: z.string(),
              role_id: z.string(),
            })
            .openapi("AssignUserRoleResponse"),
        },
      },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "last_admin — the change would leave the workspace without an administrator",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerRolesRoutes(app: OpenAPIHono<AppEnv>): void {
  const read = requirePermission("rbac:read");
  const write = requirePermission("rbac:write");

  app.use("/v1/rbac/roles", async (c, next) => {
    if (c.req.method === "GET") return read(c, next);
    if (c.req.method === "POST") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/roles/:id", async (c, next) => {
    if (c.req.method === "GET") return read(c, next);
    if (c.req.method === "PATCH" || c.req.method === "DELETE") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/roles/:id/permissions", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return write(c, next);
  });

  app.use("/v1/rbac/roles/:id/permissions/:permission", async (c, next) => {
    if (c.req.method !== "DELETE") return next();
    return write(c, next);
  });

  app.use("/v1/rbac/users/:user_id/role", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return write(c, next);
  });

  app.openapi(listRolesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const items = await rolesSvc.listRoles(db, principal.tenant_id);
    const [counts, permissions] = await Promise.all([
      rolesSvc.roleMemberCounts(db, principal.tenant_id),
      rolesSvc.tenantRolePermissions(db, principal.tenant_id),
    ]);
    return c.json(
      {
        items: items.map((role) => ({
          ...serializeRole(role),
          member_count: counts.get(role.id) ?? 0,
          permissions: permissions.get(role.id) ?? [],
        })),
      },
      200,
    );
  });

  app.openapi(getRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const role = await rolesSvc.getRole(db, principal.tenant_id, id);
    if (!role) throw new NotFoundError("role");
    const perms = await rolesSvc.listRolePermissions(db, principal.tenant_id, role.id);
    const counts = await rolesSvc.roleMemberCounts(db, principal.tenant_id);
    return c.json(
      { ...serializeRole(role), permissions: perms, member_count: counts.get(role.id) ?? 0 },
      200,
    );
  });

  app.openapi(createRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
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

  app.openapi(patchRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const patch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    };
    let role: rolesSvc.RoleRow;
    try {
      role = await rolesSvc.updateRole(db, principal.tenant_id, id, patch);
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
    return c.json(serializeRole(role), 200);
  });

  app.openapi(deleteRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
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

  app.openapi(grantRolePermissionRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
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
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(revokeRolePermissionRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id, permission } = c.req.valid("param");
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
  });

  app.openapi(assignUserRoleRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { user_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const role = await rolesSvc.getRole(db, principal.tenant_id, body.role_id);
    if (!role) throw new BadRequestError("role_id not found");
    const assigned = await identity
      .assignUserRole(db, {
        tenant_id: principal.tenant_id,
        user_id,
        role_id: body.role_id,
        role_name: role.name,
        actor: principal,
      })
      .catch((err: unknown) => {
        if (err instanceof identity.LastAdminError) throw new LastAdminConflictError(err.message);
        throw err;
      });
    if (!assigned) throw new NotFoundError("user");
    return c.json({ ok: true as const, user_id, role_id: body.role_id }, 200);
  });
}
