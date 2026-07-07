import { z } from "@hono/zod-openapi";
import type { ConversationTool } from "../index.ts";

const ListInput = z.object({}).openapi("ListKnowledgeSourcesToolInput");
const GetInput = z.object({ id: z.string().uuid() }).openapi("GetKnowledgeSourceToolInput");
const SearchInput = z
  .object({
    query: z.string().min(1),
    workflow_id: z.string().uuid().optional(),
    tags: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .openapi("SearchKnowledgeToolInputV2");

export const listKnowledgeSourcesTool: ConversationTool = {
  name: "list_knowledge_sources",
  description:
    "List the tenant's Knowledge Sources with their description and tags. Use this first to decide which source covers a topic, then call search_knowledge to pull the relevant chunks.",
  inputSchema: ListInput,
  category: "tenant_read",
  // Enumeration is gated like the typed fast-path list intent
  // (`knowledge:read`). `search_knowledge_v2` stays ungated so grounding
  // over the global `sk-ref-*` reference still works for any principal.
  permission: { action: "knowledge:read", resourceType: "knowledge" },
  async execute(ctx) {
    const rows = await ctx.engineClient.knowledgeSources.list();
    return {
      ok: true,
      data: {
        sources: rows.map((k) => ({
          id: k.id,
          name: k.name,
          slug: k.slug,
          description: k.description,
          tags: k.tags,
          scope: k.scope,
          status: k.status,
          chunk_count: k.chunk_count,
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
  permission: { action: "knowledge:read", resourceType: "knowledge", resourceIdArg: "id" },
  async execute(ctx, rawArgs) {
    const args = GetInput.parse(rawArgs);
    const k = await ctx.engineClient.knowledgeSources.get(args.id);
    if (!k) return { ok: false, data: { error: "knowledge_source_not_found" } };
    return { ok: true, data: { source: k } };
  },
};

export const searchKnowledgeV2Tool: ConversationTool = {
  name: "search_knowledge_v2",
  description:
    "Search the tenant's Knowledge Sources for domain-specific notes, runbooks, compliance rules, and reference material. Results are chunks ranked by FTS relevance; each hit names its source via source_name. Prefer a short focused query (3–6 words). Optionally pass tags to narrow to sources carrying a topic (call list_knowledge_sources first to see available tags).",
  inputSchema: SearchInput,
  category: "tenant_read",
  async execute(ctx, rawArgs) {
    const args = SearchInput.parse(rawArgs);
    const hits = await ctx.engineClient.knowledgeSources.search(args.query, {
      ...(args.workflow_id !== undefined ? { workflow_id: args.workflow_id } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
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
