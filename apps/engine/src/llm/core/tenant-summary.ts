import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { compareCategoryCounts } from "../../api/catalog-metadata.ts";
import type { Executor } from "../../db/client.ts";
import { totalOverWindow } from "../../db/list-result.ts";
import { connectors, workflows } from "../../db/schema/index.ts";

export interface TenantSummary {
  workflows: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    lifecycle: string;
    is_tool: boolean;
    category?: string;
  }>;
  workflow_categories?: ReadonlyArray<{ category: string; count: number }>;
  connectors: ReadonlyArray<{
    id: string;
    slug: string;
    display_name: string;
    driver: string;
    environment: string;
    category?: string;
  }>;
  workflows_total: number;
  connectors_total: number;
}

export const MAX_WORKFLOWS_IN_SUMMARY = 40;
export const MAX_CONNECTORS_IN_SUMMARY = 40;

export interface SnapshotCoverage {
  workflows_complete: boolean;
  connectors_complete: boolean;
}

export function snapshotCoverage(summary: {
  workflows_total: number;
  connectors_total: number;
}): SnapshotCoverage {
  return {
    workflows_complete: summary.workflows_total <= MAX_WORKFLOWS_IN_SUMMARY,
    connectors_complete: summary.connectors_total <= MAX_CONNECTORS_IN_SUMMARY,
  };
}

export async function loadSnapshotCoverage(
  tenant_id: string,
  exec: Executor,
): Promise<SnapshotCoverage> {
  const count = sql<number>`count(*)::int`;
  const [[w], [c]] = await Promise.all([
    exec
      .select({ n: count })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at))),
    exec
      .select({ n: count })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at))),
  ]);
  return snapshotCoverage({
    workflows_total: Number(w?.n ?? 0),
    connectors_total: Number(c?.n ?? 0),
  });
}

export async function loadTenantSummary(tenant_id: string, exec: Executor): Promise<TenantSummary> {
  const [workflowRows, connectorRows, categoryCounts] = await Promise.all([
    exec
      .select({
        id: workflows.id,
        slug: workflows.slug,
        name: workflows.name,
        lifecycle: workflows.lifecycle,
        is_tool: workflows.is_tool,
        category: workflows.category,
        total: totalOverWindow(),
      })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)))
      .orderBy(asc(workflows.slug))
      .limit(MAX_WORKFLOWS_IN_SUMMARY),
    exec
      .select({
        id: connectors.id,
        slug: connectors.slug,
        display_name: connectors.display_name,
        driver: connectors.driver,
        environment: connectors.environment,
        category: connectors.category,
        total: totalOverWindow(),
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), isNull(connectors.deleted_at)))
      .orderBy(asc(connectors.slug), asc(connectors.environment))
      .limit(MAX_CONNECTORS_IN_SUMMARY),
    exec
      .select({ category: workflows.category, count: sql<number>`count(*)::int` })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)))
      .groupBy(workflows.category),
  ]);
  return {
    workflows: workflowRows.map(({ total: _t, ...row }) => row),
    workflow_categories: categoryCounts
      .map((c) => ({ category: c.category, count: Number(c.count) }))
      .sort(compareCategoryCounts),
    connectors: connectorRows.map(({ total: _t, ...row }) => row),
    workflows_total: Number(workflowRows[0]?.total ?? 0),
    connectors_total: Number(connectorRows[0]?.total ?? 0),
  };
}

export function renderTenantSummaryBlock(summary: TenantSummary): string | null {
  const lines: string[] = [];
  const workflowsTotal = Math.max(summary.workflows_total, summary.workflows.length);
  const workflowsShown = summary.workflows.slice(0, MAX_WORKFLOWS_IN_SUMMARY);
  const workflowsComplete = workflowsTotal <= workflowsShown.length;
  if (workflowsShown.length > 0) {
    lines.push(`Workflows (${workflowsTotal} total):`);
    const categories = summary.workflow_categories ?? [];
    if (categories.length > 0) {
      const named = categories.map((c) => `${c.category} (${c.count})`).join(", ");
      lines.push(`Categories (exact counts over all ${workflowsTotal}): ${named}`);
    }
    for (const w of workflowsShown) {
      const toolFlag = w.is_tool ? "" : " [authoring-only]";
      const category = w.category ? ` [category=${w.category}]` : "";
      lines.push(`- ${w.slug} (${w.lifecycle})${toolFlag} — ${w.name}${category} [id=${w.id}]`);
    }
    if (!workflowsComplete) {
      lines.push(
        `- … and ${workflowsTotal - workflowsShown.length} more — call list_workflows for the complete set.`,
      );
    }
  }
  const connectorsTotal = Math.max(summary.connectors_total, summary.connectors.length);
  const connectorsShown = summary.connectors.slice(0, MAX_CONNECTORS_IN_SUMMARY);
  const connectorsComplete = connectorsTotal <= connectorsShown.length;
  if (connectorsShown.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Connectors (${connectorsTotal} total):`);
    for (const c of connectorsShown) {
      const category = c.category ? ` [category=${c.category}]` : "";
      lines.push(
        `- ${c.slug} (${c.driver}/${c.environment}) — ${c.display_name}${category} [id=${c.id}]`,
      );
    }
    if (!connectorsComplete) {
      lines.push(
        `- … and ${connectorsTotal - connectorsShown.length} more — call list_connectors for the complete set.`,
      );
    }
  }
  if (lines.length === 0) return null;
  const complete = [
    ...(workflowsComplete ? ["workflows"] : []),
    ...(connectorsComplete ? ["connectors"] : []),
  ];
  const trimmed: Array<[string, string]> = [
    ...(workflowsComplete ? [] : [["workflows", "list_workflows"] as [string, string]]),
    ...(connectorsComplete ? [] : [["connectors", "list_connectors"] as [string, string]]),
  ];
  const header =
    trimmed.length === 0
      ? [
          "=== TENANT SNAPSHOT — THIS IS THE AUTHORITATIVE LIVE LIST ===",
          "The following lines enumerate every workflow and connector that currently exists for this tenant (live DB state at turn start). Treat this block as ground truth; the user sees it implicitly. Call list_workflows / list_connectors ONLY when you need a lifecycle filter the block does not expose.",
        ]
      : [
          "=== TENANT SNAPSHOT — PARTIAL LIVE LIST ===",
          `Live DB state at turn start. The totals and category counts are exact, but the block lists at most ${MAX_WORKFLOWS_IN_SUMMARY} rows per kind, so the ${trimmed.map(([kind]) => kind).join(" and ")} lines below are only the first rows by slug — NOT every one that exists.`,
        ];
  const enumerationRules = [
    ...(complete.length > 0
      ? [
          `- If the user asks to 'list', 'show', 'display', 'zeige', 'welche', 'wieviele' ${complete.join(" or ")}, answer from the lines above. DO NOT call ${complete.map((k) => `list_${k}`).join(" or ")} to re-verify — you already have the answer.`,
        ]
      : []),
    ...trimmed.map(
      ([kind, tool]) =>
        `- The ${kind} lines above are incomplete. To list ${kind} — all of them, or one category (\`${tool}\` takes \`category\`) — call ${tool} once and answer from its result. Never say a ${kind === "workflows" ? "workflow or category" : "connector"} does not exist because it is missing from the lines above.`,
    ),
  ];
  return [
    ...header,
    "",
    ...lines,
    "",
    "HARD RULES:",
    ...enumerationRules,
    "- Use the ids and slugs above verbatim in tool calls. Never invent new ids. Never repeat a list_* call to 'double-check'.",
    "- Call get_workflow(id) / get_connector(id) only when you need fields beyond slug, name, lifecycle, driver, environment.",
    "- A plain enumeration reply is one short sentence plus bullet list of slug + name. No preamble, no follow-up questions.",
    "- Each workflow above is also exposed as a `wf_<slug>` tool. To run, call `wf_<slug>(<inputs>)` directly — that is the one-tool-call path. Use `run_workflow(workflow=<slug>)` only as a fallback. Never call `dry_run_workflow` on a saved workflow.",
    "=== END TENANT SNAPSHOT ===",
  ].join("\n");
}
