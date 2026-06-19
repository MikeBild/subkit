// list_skills — returns the applicable skills for the conversation
// scope (global + current connector + current workflow).

import { z } from "@hono/zod-openapi";
import { retrieveApplicableSkills } from "../../skills/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("ListSkillsToolInput");

export const listSkillsTool: ConversationTool = {
  name: "list_skills",
  description: "List applicable skills for the current conversation scope.",
  inputSchema,
  category: "tenant_read" as const,
  async execute(ctx, _args): Promise<ToolResult> {
    const skills = await retrieveApplicableSkills(
      {
        tenant_id: ctx.tenant_id,
        ...(ctx.connector_id ? { connector_ids: [ctx.connector_id] } : {}),
        ...(ctx.workflow_id ? { workflow_ids: [ctx.workflow_id] } : {}),
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        skills: skills.map((s) => ({
          id: s.id,
          title: s.title,
          scope: s.scope,
        })),
      },
    };
  },
};
