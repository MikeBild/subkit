import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z.object({}).openapi("ListSkillCandidatesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetSkillCandidateToolInput");

export const listSkillCandidatesTool: ConversationTool = {
  name: "list_skill_candidates",
  description:
    "List Skill Candidates — auto-proposed workflow patterns detected from execution history, awaiting approval.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.skillCandidates.list();
    return {
      ok: true,
      data: {
        candidates: rows.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          created_at: c.created_at,
        })),
      },
    };
  },
};

export const getSkillCandidateTool: ConversationTool = {
  name: "get_skill_candidate",
  description: "Fetch one skill candidate with evidence and proposed body.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const c = await ctx.engineClient.skillCandidates.get(args.id);
    if (!c) return { ok: false, data: { error: "skill_candidate_not_found" } };
    return { ok: true, data: { candidate: c } };
  },
};

export const skillCandidateReadTools: ConversationTool[] = [
  listSkillCandidatesTool,
  getSkillCandidateTool,
];
