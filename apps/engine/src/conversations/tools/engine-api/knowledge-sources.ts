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
  .openapi("SearchKnowledgeToolInput");

const SEARCH_KNOWLEDGE_DEFAULT_LIMIT = 5;

export const listKnowledgeSourcesTool: ConversationTool = {
  name: "list_knowledge_sources",
  description:
    "List the tenant's Knowledge Sources with their description and tags. Use this first to decide which source covers a topic, then call search_knowledge to pull the relevant chunks.",
  inputSchema: ListInput,
  category: "tenant_read",
  // Enumeration is gated like the typed fast-path list intent
  // (`knowledge:read`). `search_knowledge` stays ungated so grounding
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
  async execute(ctx, args: z.infer<typeof GetInput>) {
    const k = await ctx.engineClient.knowledgeSources.get(args.id);
    if (!k) return { ok: false, data: { error: "knowledge_source_not_found" } };
    return { ok: true, data: { source: k } };
  },
};

export const searchKnowledgeTool: ConversationTool = {
  name: "search_knowledge",
  description:
    "Search the tenant's Knowledge Sources for domain-specific notes, runbooks, compliance rules, and reference material. Call this when the request needs context beyond the tenant snapshot and the loaded skills — e.g. vendor-specific recipes, internal policy, error-code lookups. Results are chunks ranked by FTS relevance; each hit names its source via source_name. Prefer a short focused query (3–6 words). Optionally pass tags to narrow to sources carrying a topic (call list_knowledge_sources first to see available tags). If the first result does not answer the question, refine the query once and stop — do not spin.",
  inputSchema: SearchInput,
  category: "tenant_read",
  async execute(ctx, args: z.infer<typeof SearchInput>) {
    const workflowId = args.workflow_id ?? ctx.workflow_id;
    const hits = await ctx.engineClient.knowledgeSources.search(args.query, {
      ...(workflowId ? { workflow_id: workflowId } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      limit: args.limit ?? SEARCH_KNOWLEDGE_DEFAULT_LIMIT,
    });
    return { ok: true, data: { hits } };
  },
};

const ReadKnowledgeInput = z
  .object({
    knowledge_source_id: z.string().uuid(),
    path: z.string().optional().openapi({
      description:
        "Bundle-relative file path (e.g. /runbooks/deploy.md) to read a single concept; omit to page through the whole source.",
    }),
    offset: z.number().int().min(0).optional(),
  })
  .openapi("ReadKnowledgeToolInput");

/** Per-call content budget — keeps a full-source read LLM-friendly; callers
 *  page via `next_offset` until it disappears. */
const READ_KNOWLEDGE_MAX_CHARS = 64_000;
const READ_KNOWLEDGE_PAGE_SIZE = 50;

export const readKnowledgeTool: ConversationTool = {
  name: "read_knowledge",
  description:
    "Read the FULL content of a Knowledge Source, paginated — the follow-up to search_knowledge when a snippet is not enough (e.g. 'read me the deploy runbook'). Pass path to read one file of an imported bundle; repeat with next_offset until it is absent to retrieve everything.",
  inputSchema: ReadKnowledgeInput,
  category: "tenant_read",
  permission: {
    action: "knowledge:read",
    resourceType: "knowledge",
    resourceIdArg: "knowledge_source_id",
  },
  async execute(ctx, args: z.infer<typeof ReadKnowledgeInput>) {
    const offset = args.offset ?? 0;
    const result = await ctx.engineClient.knowledgeSources.chunks(args.knowledge_source_id, {
      ...(args.path !== undefined ? { path: args.path } : {}),
      offset,
      limit: READ_KNOWLEDGE_PAGE_SIZE,
    });
    if (!result) return { ok: false, data: { error: "knowledge_source_not_found" } };
    if (args.path !== undefined && result.chunks.length === 0 && offset === 0) {
      return {
        ok: false,
        data: {
          error: "path_not_found",
          hint: "list paths via read_knowledge without path, or search_knowledge first",
        },
      };
    }

    // Byte-bound the page: stop consuming once the budget is spent so a
    // 50-MB source can never land in one tool result.
    const chunks: {
      ordinal: number;
      title: string | null;
      path: string | null;
      content: string;
    }[] = [];
    let usedChars = 0;
    for (const c of result.chunks) {
      if (chunks.length > 0 && usedChars + c.content.length > READ_KNOWLEDGE_MAX_CHARS) break;
      chunks.push({ ordinal: c.ordinal, title: c.title, path: c.path, content: c.content });
      usedChars += c.content.length;
      if (usedChars >= READ_KNOWLEDGE_MAX_CHARS) break;
    }

    const consumed = chunks.length;
    const pageExhausted = consumed === result.chunks.length;
    const mayHaveMore = !pageExhausted || result.chunks.length === READ_KNOWLEDGE_PAGE_SIZE;

    return {
      ok: true,
      data: {
        source: {
          id: result.source.id,
          name: result.source.name,
          slug: result.source.slug,
          chunk_count: result.source.chunk_count,
        },
        chunks,
        ...(mayHaveMore ? { next_offset: offset + consumed } : {}),
      },
    };
  },
};

export const knowledgeSourceReadTools: ConversationTool[] = [
  listKnowledgeSourcesTool,
  getKnowledgeSourceTool,
  searchKnowledgeTool,
  readKnowledgeTool,
];
