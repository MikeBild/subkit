import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z.object({}).openapi("ListAllSkillsToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetSkillToolInput");

export const listAllSkillsTool: ConversationTool = {
  name: "list_all_skills",
  description:
    "List every skill owned by the tenant. Different from `list_skills` which returns only skills applicable to the current conversation scope.",
  inputSchema: ListInput,
  category: "tenant_read",
  permission: { action: "skill:read", resourceType: "skill" },
  async execute(ctx) {
    const rows = await ctx.engineClient.skills.list();
    return {
      ok: true,
      data: {
        skills: rows.map((s) => ({
          id: s.id,
          title: s.title,
          scope: s.scope,
          updated_at: s.updated_at,
        })),
      },
    };
  },
};

export const getSkillTool: ConversationTool = {
  name: "get_skill",
  description: "Fetch full skill body including examples, best_practices, pitfalls, doc_refs.",
  inputSchema: GetInput,
  category: "tenant_read",
  permission: { action: "skill:read", resourceType: "skill", resourceIdArg: "id" },
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const s = await ctx.engineClient.skills.get(args.id);
    if (!s) return { ok: false, data: { error: "skill_not_found" } };
    return { ok: true, data: { skill: s } };
  },
};

export const skillReadTools: ConversationTool[] = [listAllSkillsTool, getSkillTool];
