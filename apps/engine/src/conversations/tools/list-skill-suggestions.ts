// list_skill_suggestions — surface pending Skill Candidates relevant
// to the current conversation context.

import { z } from "@hono/zod-openapi";
import { listSkillCandidates } from "../../skill-candidates/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z.object({}).openapi("ListSkillSuggestionsToolInput");

export const listSkillSuggestionsTool: ConversationTool = {
  name: "list_skill_suggestions",
  description:
    "List pending skill improvement suggestions relevant to the current conversation context. " +
    "Returns proposed Skill Candidates that the operator can approve or dismiss.",
  inputSchema,
  async execute(ctx, _rawArgs): Promise<ToolResult> {
    const candidates = await listSkillCandidates(
      {
        tenant_id: ctx.tenant_id,
        status: "proposed",
        ...(ctx.connector_id ? { connector_id: ctx.connector_id } : {}),
        ...(ctx.workflow_id ? { workflow_id: ctx.workflow_id } : {}),
        limit: 10,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: {
        suggestions: candidates.map((c) => ({
          id: c.id,
          title: c.title,
          body: c.body,
          confidence: c.confidence,
          pattern_kind: c.pattern_kind,
          scope: c.scope,
        })),
      },
    };
  },
};
