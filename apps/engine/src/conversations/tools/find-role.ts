// find_role — fuzzy lookup over roles. Keyword search across role name
// + description, plus permission count and built-in flag.

import { z } from "@hono/zod-openapi";
import { listRolePermissions, listRoles } from "../../rbac/roles.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { keywordSearch } from "./keyword-search.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Free-text query. Matches name + description. Use "*" to list all.'),
    id: z.string().uuid().optional().describe("Exact role id; takes precedence over query."),
    include_permissions: z
      .boolean()
      .default(false)
      .describe("Inline the full permission list per match. Default: count only."),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .openapi("FindRoleToolInput");

interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  is_builtin: boolean;
  tenant_id: string | null;
  permission_count: number;
  permissions?: string[];
}

export const findRoleTool: ConversationTool = {
  name: "find_role",
  description:
    "Look up RBAC roles by exact id or free-text query. Keyword scoring across name + description. Returns built-in flag + permission count (or full permission list when include_permissions=true).",
  use_case:
    'Operator says "find the role that can approve patches" — find_role returns ranked matches with their permission count.',
  important_notes: [
    "Returns at most `limit` matches (default 15).",
    "Built-in roles (is_builtin=true) cannot be edited via edit_role; their config is fixed.",
    "Use `include_permissions: true` only when authoring an edit — defaults to count to keep responses small.",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const all = await listRoles(ctx.db, ctx.tenant_id);
    const augmented: RoleSummary[] = await Promise.all(
      all.map(async (r) => {
        const perms = await listRolePermissions(ctx.db, r.id);
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          is_builtin: r.is_builtin,
          tenant_id: r.tenant_id,
          permission_count: perms.length,
          ...(args.include_permissions ? { permissions: perms } : {}),
        };
      }),
    );
    if (args.id) {
      const match = augmented.find((r) => r.id === args.id);
      if (!match) {
        return {
          ok: false,
          error_code: "role_not_found",
          message: `no role with id \`${args.id}\``,
          next_best_actions: ["find_role", "list_roles"],
        };
      }
      return { ok: true, data: { matches: [match], total: 1 } };
    }
    const ranked = keywordSearch(
      args.query ?? "*",
      augmented,
      (r) => `${r.name} ${r.description ?? ""}`,
    );
    const limited = ranked.slice(0, args.limit);
    return {
      ok: true,
      data: {
        matches: limited,
        total: ranked.length,
        ...(ranked.length > limited.length ? { truncated: true } : {}),
      },
    };
  },
};
