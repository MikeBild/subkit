// find_workflow — fuzzy lookup over the saved-workflow catalog.
// Keyword overlap against
// id/slug/name/description/step.id/step.kind/step.connector_id.
//
// Read-only. Use when the operator says "do we have a HubSpot
// workflow somewhere?" or "find that orders thing I built last
// month". For "fetch by exact id" call `get_workflow`.

import { z } from "@hono/zod-openapi";
import {
  bindingFor,
  type EffectiveTrigger,
  workflowTriggerView,
} from "../../scheduler/trigger-bindings.ts";
import { UNCATEGORIZED } from "../../workflows/categorize.ts";
import type { WorkflowTrigger } from "../../workflows/types.ts";
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
    category: z
      .string()
      .optional()
      .describe("Restrict the search to one catalog block (see `category` on each match)."),
    connector: z
      .string()
      .optional()
      .describe(
        "Restrict the search to workflows using this connector (id or slug), counting both a bound connector_id and a ${connector.<slug>.base_url} url.",
      ),
    limit: z.number().int().min(1).max(50).default(15),
  })
  .openapi("FindWorkflowToolInput");

interface WorkflowSummary {
  id: string;
  slug: string;
  name: string;
  current_version: number | null;
  description: string | null;
  category?: string;
  connectors?: string[];
  /** What really starts the workflow — see `scheduler/trigger-bindings.ts`. */
  effective_trigger?: EffectiveTrigger;
  steps: Array<{ id: string; kind: string; connector_id: string | null }>;
}

export function summarize(wf: {
  id: string;
  slug: string;
  name: string;
  current_version: number | null;
  description?: string | null | undefined;
  definition?: { description?: string | null | undefined; steps?: Array<Record<string, unknown>> };
  steps?: Array<Record<string, unknown>>;
}): WorkflowSummary {
  const stepArr = (wf.definition?.steps ?? wf.steps ?? []) as Array<Record<string, unknown>>;
  return {
    id: wf.id,
    slug: wf.slug,
    name: wf.name,
    current_version: wf.current_version ?? null,
    // Row description (editable metadata) wins over the DAG's authoring-time
    // description, matching the HTTP catalog (routes/workflows.ts) and MCP
    // resources. Otherwise a metadata-only update_workflow leaves this stale.
    description: wf.description ?? wf.definition?.description ?? null,
    steps: stepArr.map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      kind: typeof s.kind === "string" ? s.kind : "unknown",
      connector_id: typeof s.connector_id === "string" ? s.connector_id : null,
    })),
  };
}

function withTrigger(
  summary: WorkflowSummary,
  definitionTrigger: WorkflowTrigger | undefined,
  bindings: Parameters<typeof bindingFor>[0],
): WorkflowSummary {
  const view = workflowTriggerView(definitionTrigger, bindingFor(bindings, summary.id));
  return { ...summary, effective_trigger: view.effective_trigger };
}

function searchableText(s: WorkflowSummary): string {
  return [
    s.id,
    s.slug,
    s.name,
    s.description ?? "",
    // The catalog block and the connector slugs are searchable too, so
    // "notion" or "gmail" finds the family even when no step id spells it.
    s.category ?? "",
    ...(s.connectors ?? []),
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
    "Look up saved workflows by exact id or free-text query. Keyword scoring across id/slug/name/description/category/connectors/step.id/step.kind/step.connector_id, and narrowable with `category` or `connector`. Use this before list_workflows for catalogs over ~50 entries.",
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
      const bindings = await ctx.engineClient.workflows.triggerBindings([wf.id]);
      return {
        ok: true,
        data: { matches: [withTrigger(summarize(wf), wf.definition.trigger, bindings)], total: 1 },
      };
    }
    // Complete catalog (service default = safety bound) so a match can
    // never be missed because it sat beyond an arbitrary page size.
    const { rows: list } = await ctx.engineClient.workflows.list({
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.connector !== undefined ? { connector: args.connector } : {}),
    });
    // Derived over the whole catalog, so a match reports the block it really
    // belongs to even when the search was narrowed.
    const [categories, connectorRefs, bindings] = await Promise.all([
      ctx.engineClient.workflows.categories(),
      ctx.engineClient.workflows.connectorRefs(),
      ctx.engineClient.workflows.triggerBindings(list.map((wf) => wf.id)),
    ]);
    const summaries = list.map((wf) => ({
      ...withTrigger(summarize(wf), wf.definition.trigger, bindings),
      category: categories.get(wf.slug) ?? UNCATEGORIZED,
      connectors: connectorRefs.get(wf.id) ?? [],
    }));
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
