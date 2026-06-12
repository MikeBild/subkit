// find_workflow — fuzzy lookup over the saved-workflow catalog.
// Mirrors the reference impl's `find_tool`: keyword overlap against
// id/slug/name/description/step.id/step.kind/step.connector_id.
//
// Read-only. Use when the operator says "do we have a HubSpot
// workflow somewhere?" or "find that orders thing I built last
// month". For "fetch by exact id" call `get_workflow`.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "./index.ts";
import { keywordSearch } from "./keyword-search.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Free-text query. Matches against id, slug, name, description, step ids/kinds/connector_ids. Use "*" or omit to list all.',
      ),
    id: z.string().min(1).optional().describe("Exact workflow id; takes precedence over query."),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .openapi("FindWorkflowToolInput");

interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  current_version: number | null;
  description: string | null;
  steps: Array<{ id: string; kind: string; connector_id: string | null }>;
}

function summarize(wf: {
  id: string;
  slug: string;
  name: string;
  current_version: number | null;
  definition?: { description?: string | null | undefined; steps?: Array<Record<string, unknown>> };
  steps?: Array<Record<string, unknown>>;
}): WorkflowSummary {
  const stepArr = (wf.definition?.steps ?? wf.steps ?? []) as Array<Record<string, unknown>>;
  return {
    id: wf.id,
    slug: wf.slug,
    name: wf.name,
    current_version: wf.current_version ?? null,
    description: wf.definition?.description ?? null,
    steps: stepArr.map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      kind: typeof s.kind === "string" ? s.kind : "unknown",
      connector_id: typeof s.connector_id === "string" ? s.connector_id : null,
    })),
  };
}

function searchableText(s: WorkflowSummary): string {
  return [
    s.id,
    s.slug,
    s.name,
    s.description ?? "",
    ...s.steps.map((st) => st.id),
    ...s.steps.map((st) => st.kind),
    ...s.steps.map((st) => st.connector_id ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
}

export const findWorkflowTool: ConversationTool = {
  name: "find_workflow",
  description:
    "Look up saved workflows by exact id or free-text query. Keyword scoring across id/slug/name/description/step.id/step.kind/step.connector_id. Use this before list_workflows for catalogs over ~50 entries.",
  use_case:
    'Operator says "do we have a HubSpot workflow already?" or "find the orders thing I built". Faster than scrolling list_workflows for large tenants.',
  important_notes: [
    "Returns at most `limit` matches (default 15). Increase `limit` if the LLM needs more context.",
    "When `id` is supplied, only that workflow is returned; query is ignored.",
    'Use "*" or omit both fields to list all (capped by `limit`).',
  ],
  inputSchema,
  category: "tenant_read",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    if (args.id) {
      const wf = await ctx.engineClient.workflows.get(args.id);
      if (!wf) {
        return {
          ok: false,
          error_code: "workflow_not_found",
          message: `no workflow with id \`${args.id}\``,
          next_best_actions: ["find_workflow", "list_workflows"],
        };
      }
      return { ok: true, data: { matches: [summarize(wf)], total: 1 } };
    }
    // Complete catalog (service default = safety bound) so a match can
    // never be missed because it sat beyond an arbitrary page size.
    const { rows: list } = await ctx.engineClient.workflows.list();
    const summaries = list.map(summarize);
    const ranked = keywordSearch(args.query ?? "*", summaries, searchableText);
    const limited = ranked.slice(0, args.limit);
    return {
      ok: true,
      data: {
        matches: limited,
        total: ranked.length,
        ...(ranked.length > limited.length ? { truncated: true } : {}),
      },
    };
  },
};
