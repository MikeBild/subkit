import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  deleteRoleOperation,
  getRoleOperation,
  listRolesOperation,
  revokeRolePermissionOperation,
} from "../../../api/operations/rbac.ts";
import { RbacRoleSchema, serializeRole } from "../../../api/operations/rbac-representation.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as identity from "../../../identity/index.ts";
import * as rolesSvc from "../../../rbac/index.ts";
import { BadRequestError, LastAdminConflictError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { mapRoleError } from "./shared.ts";

const UserIdParam = z.object({ user_id: z.string().uuid() });

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
  const write = requirePermission("rbac:write");

  app.use("/v1/rbac/roles", async (c, next) => {
    if (c.req.method === "POST") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/roles/:id", async (c, next) => {
    if (c.req.method === "PATCH") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/roles/:id/permissions", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return write(c, next);
  });

  app.use("/v1/rbac/users/:user_id/role", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return write(c, next);
  });

  toHonoRoute(app, listRolesOperation);

  toHonoRoute(app, getRoleOperation);

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

  toHonoRoute(app, deleteRoleOperation);

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

  toHonoRoute(app, revokeRolePermissionOperation);

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
