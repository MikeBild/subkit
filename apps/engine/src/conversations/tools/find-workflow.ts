import { z } from "@hono/zod-openapi";
import { listedDescription } from "../../api/catalog-metadata.ts";
import { type EffectiveTrigger, workflowTriggerView } from "../../scheduler/trigger-bindings.ts";
import {
  loadWorkflowDetail,
  loadWorkflowList,
  type WorkflowDetailEntry,
} from "../../workflows/read-model.ts";
import { rankedPage } from "./catalog-rank.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { invalidLookupId, normalizeLookupCategory, normalizeLookupId } from "./lookup-id.ts";

const inputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Free-text query, a few distinctive words. Ranked by category, then slug and name, then description, then connectors and step ids; each match lists the `reasons` it matched on. Use "*" or omit to list all.',
      ),
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exact workflow uuid; takes precedence over query. Omit it to search by query; "*" counts as omitted.',
      ),
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
  category: string;
  connectors?: string[];
  effective_trigger?: EffectiveTrigger;
  steps: Array<{ id: string; kind: string; connector_id: string | null }>;
}

export function summarize(wf: {
  id: string;
  slug: string;
  name: string;
  current_version: number | null;
  description: string | null;
  category: string;
  definition?: { steps?: Array<Record<string, unknown>> };
  steps?: Array<Record<string, unknown>>;
}): WorkflowSummary {
  const stepArr = (wf.definition?.steps ?? wf.steps ?? []) as Array<Record<string, unknown>>;
  return {
    id: wf.id,
    slug: wf.slug,
    name: wf.name,
    current_version: wf.current_version ?? null,
    description: listedDescription(wf.description),
    category: wf.category,
    steps: stepArr.map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      kind: typeof s.kind === "string" ? s.kind : "unknown",
      connector_id: typeof s.connector_id === "string" ? s.connector_id : null,
    })),
  };
}

function withTrigger(summary: WorkflowSummary, entry: WorkflowDetailEntry): WorkflowSummary {
  const view = workflowTriggerView(entry.workflow.definition.trigger, entry.binding);
  return { ...summary, effective_trigger: view.effective_trigger };
}

function rankFields(s: WorkflowSummary) {
  return {
    category: [s.category],
    identity: [s.slug, s.name],
    description: [s.description],
    detail: [
      ...(s.connectors ?? []),
      ...s.steps.map((st) => st.id),
      ...s.steps.map((st) => st.connector_id ?? ""),
    ],
  };
}

export const findWorkflowTool: ConversationTool = {
  name: "find_workflow",
  description:
    "Look up saved workflows by exact id or free-text query — the way to reach every workflow, including the ones not listed as a `wf_<slug>` tool. Matches are ranked by category, slug and name, description and connectors, and each says why it matched (`reasons`). Narrow with `category` or `connector`.",
  use_case:
    'Operator says "do we have a HubSpot workflow already?" or "find the orders thing I built". Faster than scrolling list_workflows for large tenants.',
  important_notes: [
    "Returns at most `limit` matches (default 15). Increase `limit` if the LLM needs more context.",
    "When `id` is supplied, only that workflow is returned; query is ignored.",
    'Use "*" or omit both fields to list all (capped by `limit`).',
  ],
  inputSchema,
  category: "tenant_read",
  permission: { action: "workflow:read", resourceType: "workflow", resourceIdArg: "id" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const parsed = inputSchema.parse(rawArgs);
    const lookupId = normalizeLookupId(parsed.id);
    if (lookupId.kind === "invalid") return invalidLookupId("workflow", "find_workflow");
    const category = normalizeLookupCategory(parsed.category);
    const args = { ...parsed, category };
    if (lookupId.kind === "uuid") {
      const entry = await loadWorkflowDetail(ctx.tenant_id, { id: lookupId.id }, ctx.db);
      if (!entry) {
        return {
          ok: false,
          error_code: "workflow_not_found",
          message: `no workflow with id \`${lookupId.id}\``,
          next_best_actions: ["find_workflow", "list_workflows"],
        };
      }
      return {
        ok: true,
        data: { matches: [withTrigger(summarize(entry.workflow), entry)], total: 1 },
      };
    }
    const { entries } = await loadWorkflowList(
      ctx.tenant_id,
      {
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.connector !== undefined ? { connector: args.connector } : {}),
      },
      ctx.db,
    );
    const summaries = entries.map((entry) => ({
      ...withTrigger(summarize(entry.workflow), entry),
      connectors: entry.connectors,
    }));
    return {
      ok: true,
      data: rankedPage(args.query, summaries, rankFields, args.limit, "list_workflows"),
    };
  },
};
