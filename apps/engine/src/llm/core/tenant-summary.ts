import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { compareCategoryCounts } from "../../api/catalog-metadata.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { connectors, workflows } from "../../db/schema/index.ts";
import { catalogVisibility } from "../../rbac/evaluator.ts";

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

export interface VisibleCatalog {
  workflows: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    lifecycle: string;
    is_tool: boolean;
    category: string;
  }>;
  connectors: ReadonlyArray<{
    id: string;
    slug: string;
    display_name: string;
    driver: string;
    environment: string;
    category: string;
  }>;
}

export async function loadVisibleCatalog(
  principal: ResolvedPrincipal,
  db: Db,
): Promise<VisibleCatalog> {
  const [workflowVisible, connectorVisible, workflowRows, connectorRows] = await Promise.all([
    catalogVisibility(db, principal, "workflow:read", "workflow"),
    catalogVisibility(db, principal, "connector:read", "connector"),
    db
      .select({
        id: workflows.id,
        slug: workflows.slug,
        name: workflows.name,
        lifecycle: workflows.lifecycle,
        is_tool: workflows.is_tool,
        category: workflows.category,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, principal.tenant_id),
          isNull(workflows.deleted_at),
          ne(workflows.lifecycle, "archived"),
        ),
      )
      .orderBy(asc(workflows.slug)),
    db
      .select({
        id: connectors.id,
        slug: connectors.slug,
        display_name: connectors.display_name,
        driver: connectors.driver,
        environment: connectors.environment,
        category: connectors.category,
      })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, principal.tenant_id), isNull(connectors.deleted_at)))
      .orderBy(asc(connectors.slug), asc(connectors.environment)),
  ]);
  const allowlist = principal.allowed_workflows;
  const allowlisted = (id: string) => !Array.isArray(allowlist) || allowlist.includes(id);
  return {
    workflows: workflowVisible
      ? workflowRows.filter((row) => workflowVisible(row.id) && allowlisted(row.id))
      : [],
    connectors: connectorVisible ? connectorRows.filter((row) => connectorVisible(row.id)) : [],
  };
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

export function visibleCatalogCoverage(catalog: VisibleCatalog): SnapshotCoverage {
  return snapshotCoverage({
    workflows_total: catalog.workflows.length,
    connectors_total: catalog.connectors.length,
  });
}

export async function loadSnapshotCoverage(
  principal: ResolvedPrincipal,
  db: Db,
): Promise<SnapshotCoverage> {
  return visibleCatalogCoverage(await loadVisibleCatalog(principal, db));
}

export async function loadTenantSummary(
  principal: ResolvedPrincipal,
  db: Db,
): Promise<TenantSummary> {
  const catalog = await loadVisibleCatalog(principal, db);
  const counts = new Map<string, number>();
  for (const row of catalog.workflows) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }
  return {
    workflows: catalog.workflows.slice(0, MAX_WORKFLOWS_IN_SUMMARY),
    workflow_categories: [...counts]
      .map(([category, count]) => ({ category, count }))
      .sort(compareCategoryCounts),
    connectors: catalog.connectors.slice(0, MAX_CONNECTORS_IN_SUMMARY),
    workflows_total: catalog.workflows.length,
    connectors_total: catalog.connectors.length,
  };
}

export function renderTenantSummaryBlock(
  summary: TenantSummary,
  workflowToolSlugs: ReadonlySet<string>,
): string | null {
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
      const toolMarker = workflowToolSlugs.has(w.slug) ? ` [tool: wf_${w.slug}]` : "";
      const category = w.category ? ` [category=${w.category}]` : "";
      lines.push(
        `- ${w.slug} (${w.lifecycle})${toolFlag}${toolMarker} — ${w.name}${category} [id=${w.id}]`,
      );
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
    "- Workflows marked [tool: wf_<slug>] are callable directly as that tool; every other workflow runs via run_workflow(workflow=<slug>). Never call `dry_run_workflow` on a saved workflow.",
    "=== END TENANT SNAPSHOT ===",
  ].join("\n");
}
