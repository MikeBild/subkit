import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../../api/catalog-metadata.ts";
import type { ConversationTool } from "../index.ts";

const ListInput = z
  .object({
    category: z
      .string()
      .optional()
      .describe("Only sources in this catalog block (see `category` on each source)."),
  })
  .openapi("ListKnowledgeSourcesToolInput");
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
    "List the tenant's Knowledge Sources with what each covers (`description`), its catalog block (`category`, also a filter) and its tags. Use this first to decide which source covers a topic, then call search_knowledge to pull the relevant chunks.",
  inputSchema: ListInput,
  category: "tenant_read",
  permission: { action: "knowledge:read", resourceType: "knowledge" },
  async execute(ctx, args: z.infer<typeof ListInput>) {
    const all = await ctx.engineClient.knowledgeSources.list();
    const rows = all.filter((k) => args?.category === undefined || k.category === args.category);
    const filtered =
      args?.category === undefined
        ? {}
        : {
            category_filter: args.category,
            total_sources: all.length,
            categories: [...new Set(all.map((k) => k.category))].sort(),
            ...(rows.length === 0 && all.length > 0
              ? {
                  hint: `No source in category '${args.category}', but the workspace has ${all.length} source(s) in other categories, listed in sources_in_other_categories. Use them before telling the person nothing was found.`,
                  sources_in_other_categories: all.slice(0, 25).map((k) => ({
                    id: k.id,
                    name: k.name,
                    category: k.category,
                  })),
                }
              : {}),
          };
    return {
      ok: true,
      data: {
        ...filtered,
        sources: rows.map((k) => ({
          id: k.id,
          name: k.name,
          slug: k.slug,
          description: listedDescription(k.description),
          category: k.category,
          tags: k.tags,
          scope: k.scope,
          status: k.status,
          source_type: k.source_type,
          version: k.version,
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
