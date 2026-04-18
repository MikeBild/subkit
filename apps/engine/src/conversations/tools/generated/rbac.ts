import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const EmptyInput = z.object({}).openapi("RbacEmptyInput");
const IdInput = z.object({ id: z.string().uuid() }).openapi("RbacIdInput");

export const listRolesTool: ConversationTool = {
  name: "list_roles",
  description: "List RBAC roles for the tenant.",
  inputSchema: EmptyInput,
  category: "tenant_read",
  async execute(ctx) {
    const roles = await ctx.engineClient.rbac.listRoles();
    return { ok: true, data: { roles } };
  },
};

export const getRoleTool: ConversationTool = {
  name: "get_role",
  description: "Fetch a single role by id including its permissions.",
  inputSchema: IdInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = IdInput.parse(rawArgs);
    const role = await ctx.engineClient.rbac.getRole(args.id);
    if (!role) return { ok: false, data: { error: "role_not_found" } };
    const permissions = await ctx.engineClient.rbac.listRolePermissions(role.id);
    return { ok: true, data: { role, permissions } };
  },
};

export const rbacReadTools: ConversationTool[] = [listRolesTool, getRoleTool];
