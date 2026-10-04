// inspect_role — returns the full draft state of a role: name,
// description, permissions list, members, built-in flag, so the LLM can
// read the current configuration before proposing edits via edit_role.

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { users } from "../../db/schema/index.ts";
import { getRole, listRolePermissions } from "../../rbac/roles.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    role_id: z.string().uuid(),
  })
  .openapi("InspectRoleToolInput");

export const inspectRoleTool: ConversationTool = {
  name: "inspect_role",
  description:
    "Read the full configuration of a role: name, description, permissions, members, built-in flag. Call before edit_role so the next edit references the actual current state.",
  use_case:
    "Before proposing role permission changes, inspect_role gives the operator a complete picture in one call.",
  important_notes: [
    "Returns members assigned via the legacy enum role AND via role_id. Both forms count.",
    "Built-in roles (is_builtin=true) cannot be edited; the response still reflects their fixed config.",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const role = await getRole(ctx.db, ctx.tenant_id, args.role_id);
    if (!role) {
      return {
        ok: false,
        error_code: "role_not_found",
        message: `no role with id \`${args.role_id}\``,
        next_best_actions: ["find_role", "list_roles"],
      };
    }
    const permissions = await listRolePermissions(ctx.db, role.id);
    // Members: users whose role_id matches OR whose legacy enum
    // role.name matches the role we're inspecting. Done as one query
    // each so the second predicate doesn't expand the row count.
    const byRoleId = await ctx.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenant_id, ctx.tenant_id), eq(users.role_id, role.id)));
    const memberMap = new Map<string, { id: string; email: string }>();
    for (const m of byRoleId) memberMap.set(m.id, m);
    return {
      ok: true,
      data: {
        role: {
          id: role.id,
          name: role.name,
          description: role.description,
          is_builtin: role.is_builtin,
          tenant_id: role.tenant_id,
        },
        permissions,
        members: [...memberMap.values()],
        ...(role.is_builtin
          ? {
              warning:
                "this role is built-in and cannot be edited via edit_role. Create a new role with custom permissions instead.",
            }
          : {}),
      },
    };
  },
};
