import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z.object({}).openapi("ListKnowledgeSourcesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetKnowledgeSourceToolInput");
const SearchInput = z
  .object({
    query: z.string().min(1),
    workflow_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .openapi("SearchKnowledgeToolInputV2");

export const listKnowledgeSourcesTool: ConversationTool = {
  name: "list_knowledge_sources",
  description: "List the tenant's ingested knowledge sources.",
  inputSchema: ListInput,
  category: "tenant_read",
  async execute(ctx) {
    const rows = await ctx.engineClient.knowledgeSources.list();
    return {
      ok: true,
      data: {
        sources: rows.map((k) => ({
          id: k.id,
          name: k.name,
          slug: k.slug,
          scope: k.scope,
          status: k.status,
        })),
      },
    };
  },
};

export const getKnowledgeSourceTool: ConversationTool = {
  name: "get_knowledge_source",
  description: "Fetch a single knowledge source by id.",
  inputSchema: GetInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const k = await ctx.engineClient.knowledgeSources.get(args.id);
    if (!k) return { ok: false, data: { error: "knowledge_source_not_found" } };
    return { ok: true, data: { source: k } };
  },
};

export const searchKnowledgeV2Tool: ConversationTool = {
  name: "search_knowledge_v2",
  description: "Full-text search across ingested knowledge sources. Returns ranked snippets.",
  inputSchema: SearchInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = SearchInput.parse(rawArgs);
    const hits = await ctx.engineClient.knowledgeSources.search(args.query, {
      ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return { ok: true, data: { hits } };
  },
};

export const knowledgeSourceReadTools: ConversationTool[] = [
  listKnowledgeSourcesTool,
  getKnowledgeSourceTool,
  searchKnowledgeV2Tool,
];
