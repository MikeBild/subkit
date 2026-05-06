// find_user — fuzzy lookup over the tenant's users. Returns email,
// name, role assignments. Mirrors the reference impl's `find_user`.

import { z } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { roles } from "../../db/schema/index.ts";
import { getUser, listUsers } from "../../identity/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { keywordSearch } from "./keyword-search.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Free-text query. Matches email, name, role. Use "*" to list all.'),
    id: z.string().uuid().optional().describe("Exact user id; takes precedence over query."),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .openapi("FindUserToolInput");

interface UserSummary {
  id: string;
  email: string;
  role: string;
  role_id: string | null;
  role_name: string | null;
}

export const findUserTool: ConversationTool = {
  name: "find_user",
  description:
    "Look up users by exact id or free-text query. Keyword scoring across email + name + role.",
  use_case:
    'Operator says "what role does ada@example.com have?" — find_user returns the user with their role assignment in one call.',
  important_notes: [
    "Returns at most `limit` matches (default 15).",
    "When `id` is supplied, only that user is returned.",
    "The `role` field carries the legacy enum role; `role_name` carries the named-role assignment when present.",
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    if (args.id) {
      const u = await getUser(ctx.tenant_id, args.id, ctx.db);
      if (!u) {
        return {
          ok: false,
          error_code: "user_not_found",
          message: `no user with id \`${args.id}\``,
          next_best_actions: ["find_user", "list_users"],
        };
      }
      let role_name: string | null = null;
      if (u.role_id) {
        // tenant-filter:exempt — tenant-scoped via conversation_id parent FK on the calling row
        const named = await ctx.db
          .select({ name: roles.name })
          .from(roles)
          .where(eq(roles.id, u.role_id))
          .limit(1);
        role_name = named[0]?.name ?? null;
      }
      return {
        ok: true,
        data: {
          matches: [
            {
              id: u.id,
              email: u.email,
              role: u.role,
              role_id: u.role_id ?? null,
              role_name,
            },
          ],
          total: 1,
        },
      };
    }
    const list = await listUsers(ctx.tenant_id, { limit: 200 }, ctx.db);
    // Bulk-resolve role names so we don't issue N queries.
    const roleIds = list
      .map((u) => u.role_id)
      .filter((rid): rid is string => typeof rid === "string");
    const roleRows =
      roleIds.length > 0
        ? // tenant-filter:exempt — tenant-scoped via conversation_id parent FK on the calling row
          await ctx.db
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(inArray(roles.id, roleIds))
        : [];
    const roleNameById = new Map(roleRows.map((r) => [r.id, r.name]));
    const summaries: UserSummary[] = list.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      role_id: u.role_id ?? null,
      role_name: u.role_id ? (roleNameById.get(u.role_id) ?? null) : null,
    }));
    const ranked = keywordSearch(
      args.query ?? "*",
      summaries,
      (u) => `${u.email} ${u.role} ${u.role_name ?? ""}`,
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
