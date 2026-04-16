// search_knowledge — search across Knowledge Sources in scope.

import { z } from "@hono/zod-openapi";
import { searchKnowledge } from "../../knowledge/service.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(20).optional(),
  })
  .openapi("SearchKnowledgeToolInput");

export const searchKnowledgeTool: ConversationTool = {
  name: "search_knowledge",
  description:
    "Search the tenant's Knowledge Sources for relevant domain knowledge. Returns matching chunks ranked by relevance.",
  inputSchema,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const hits = await searchKnowledge(
      {
        tenant_id: ctx.tenant_id,
        query: args.query,
        ...(ctx.workflow_id ? { workflow_id: ctx.workflow_id } : {}),
        limit: args.limit ?? 5,
      },
      ctx.db,
    );
    return {
      ok: true,
      data: { hits: hits.slice(0, 10) },
    };
  },
};
