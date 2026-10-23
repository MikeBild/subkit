import { z } from "@hono/zod-openapi";
import { asc, eq } from "drizzle-orm";
import { connectors as connectorsTable } from "../../db/schema/index.ts";
import { searchDocs } from "../../docs-ingestion/service.ts";
import { type GroundedConnector, resolveConnectors } from "../authoring-grounding.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { collectDraftConnectorRefs } from "./probed-connectors.ts";

const MAX_SCOPED_CONNECTORS = 6;
const MAX_TOTAL_HITS = 20;
const RESOLVABLE_SLUGS_LIMIT = 25;

const inputSchema = z
  .object({
    query: z.string().min(1),
    connector: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Connector id or slug to search. Omit it to search every connector the current draft calls plus the conversation's bound connector.",
      ),
    limit: z.number().int().positive().max(20).optional(),
  })
  .openapi("FetchConnectorDocsToolInput");

async function resolvableSlugs(ctx: ToolContext): Promise<string[]> {
  const rows = await ctx.db
    .select({ slug: connectorsTable.slug })
    .from(connectorsTable)
    .where(eq(connectorsTable.tenant_id, ctx.tenant_id))
    .orderBy(asc(connectorsTable.slug))
    .limit(RESOLVABLE_SLUGS_LIMIT);
  return [...new Set(rows.map((r) => r.slug))];
}

function draftConnectorRefs(ctx: ToolContext): string[] {
  const steps = ctx.getDraft().workflow?.steps ?? [];
  const { connectorIds, slugCandidates } = collectDraftConnectorRefs(steps);
  return [...(ctx.connector_id ? [ctx.connector_id] : []), ...connectorIds, ...slugCandidates];
}

export const fetchConnectorDocsTool: ConversationTool = {
  name: "fetch_connector_docs",
  description:
    "Search the ingested connector docs (OpenAPI specs, API references, vendor notes). Call this before drafting a `request` step or answering vendor-API questions — endpoints, required headers, auth shapes, pagination tokens should come from docs, not guesses. Use a short focused query matching the endpoint or concept you need. Pass `connector` (id or slug) to search one connector; without it every connector the current draft calls, plus the conversation's bound connector, is searched and each hit names its `connector_slug`. Returns `connector_scope_required` with the resolvable slugs when nothing is in scope.",
  inputSchema,
  category: "tenant_read" as const,
  authoring_only: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const refs = args.connector ? [args.connector] : draftConnectorRefs(ctx);
    const { resolved, unresolved } =
      refs.length > 0 ? await resolveConnectors(ctx, refs) : { resolved: [], unresolved: [] };
    const scoped: GroundedConnector[] = [];
    const seen = new Set<string>();
    for (const c of resolved) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      scoped.push(c);
    }
    if (scoped.length === 0) {
      return {
        ok: false,
        data: {
          error_code: "connector_scope_required",
          error: args.connector
            ? `connector "${args.connector}" does not resolve for this tenant — pass one of resolvable_connectors`
            : "no connector in scope — pass `connector` (id or slug), or add a request step bound to a connector to the draft first",
          resolvable_connectors: await resolvableSlugs(ctx),
          ...(unresolved.length > 0 ? { unresolved_connectors: unresolved } : {}),
          next_best_actions: ["list_connectors", "find_connector", "fetch_connector_docs"],
        },
      };
    }
    const limit = args.limit ?? 5;
    const searched = scoped.slice(0, MAX_SCOPED_CONNECTORS);
    const perConnector = await Promise.all(
      searched.map(async (c) => {
        const hits = await searchDocs(
          { tenant_id: ctx.tenant_id, connector_id: c.id, query: args.query, limit },
          ctx.db,
        );
        return hits
          .slice(0, limit)
          .map((hit) => ({ ...hit, connector_id: c.id, connector_slug: c.slug }));
      }),
    );
    const hits = perConnector
      .flat()
      .sort((left, right) => right.rank - left.rank)
      .slice(0, Math.min(MAX_TOTAL_HITS, limit * searched.length));
    return {
      ok: true,
      data: {
        hits,
        connectors_searched: searched.map((c) => c.slug),
        ...(scoped.length > searched.length
          ? { connectors_skipped: scoped.slice(searched.length).map((c) => c.slug) }
          : {}),
        ...(unresolved.length > 0 ? { unresolved_connectors: unresolved } : {}),
      },
    };
  },
};
