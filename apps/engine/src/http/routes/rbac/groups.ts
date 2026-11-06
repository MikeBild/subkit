import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { toHonoRoute } from "../../../api/operations/hono.ts";
import {
  addGroupMemberOperation,
  assignGroupRoleOperation,
  deleteGroupOperation,
  listGroupsOperation,
  removeGroupMemberOperation,
  revokeGroupRoleOperation,
} from "../../../api/operations/rbac.ts";
import { RbacGroupSchema, serializeGroup } from "../../../api/operations/rbac-representation.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import * as groupsSvc from "../../../rbac/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

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

export function registerGroupsRoutes(app: OpenAPIHono<AppEnv>): void {
  const write = requirePermission("rbac:write");

  app.use("/v1/rbac/groups", async (c, next) => {
    if (c.req.method === "POST") return write(c, next);
    return next();
  });

  app.use("/v1/rbac/groups/:id", async (c, next) => {
    if (c.req.method === "PATCH") return write(c, next);
    return next();
  });

  toHonoRoute(app, listGroupsOperation);

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

  toHonoRoute(app, deleteGroupOperation);

  toHonoRoute(app, addGroupMemberOperation);

  toHonoRoute(app, removeGroupMemberOperation);

  toHonoRoute(app, assignGroupRoleOperation);

  toHonoRoute(app, revokeGroupRoleOperation);
}
