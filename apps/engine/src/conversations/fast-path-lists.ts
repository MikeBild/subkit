// Fast-path catalog renderers (Fix 3, sessions 2026-06-11/12).
//
// Workflows / connectors / schedules / knowledge sources are bounded
// business catalogs — the fast path enumerates them COMPLETELY and the
// headline names the exact total ("20 workflows:" only when 20 are
// shown). The 1000 cap is a safety bound, not a page size; if a tenant
// ever exceeds it the reply says "showing first 1000 of N" instead of
// lying by omission. Executions are an unbounded history: they stay
// paged, but the headline always renders from the true total
// ("showing latest 10 of 312 executions").
//
// Extracted from fast-path.ts so the matcher stays focused on intent
// routing; the RBAC gating for these renderers lives at the call site
// (`tryFastPath` checks the same `*:read` permissions the HTTP routes
// enforce).

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { categoryOfConnector } from "../connectors/categorize.ts";
import { totalOverWindow } from "../db/list-result.ts";
import {
  connectors,
  knowledgeSources,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../db/schema/index.ts";
import { listExecutions } from "../execution/list.ts";
import { loadCategoryIndex } from "../workflows/catalog-view.ts";
import { deriveCategories, groupByCategory, UNCATEGORIZED } from "../workflows/categorize.ts";
import type { FastPathParams } from "./fast-path.ts";

const CATALOG_SAFETY_LIMIT = 1000;
const EXECUTIONS_PAGE_SIZE = 10;

/**
 * Headline for a complete-or-capped catalog enumeration. `shown` and
 * `total` agree on every tenant below the safety bound, so the common
 * case reads "20 workflows:" — exact, no "more" marker needed.
 */
function catalogHeadline(noun: string, shown: number, total: number): string {
  if (shown >= total) return `${total} ${noun}${total === 1 ? "" : "s"}:`;
  return `Showing first ${shown} of ${total} ${noun}s (narrow the list with a filter):`;
}

export interface RenderPayload {
  ok: boolean;
  reply: string;
  data: Record<string, unknown>;
}

export async function renderWorkflowsList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
      total: totalOverWindow(),
    })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, p.tenant_id), isNull(workflows.deleted_at)))
    .orderBy(desc(workflows.last_executed_at), asc(workflows.created_at))
    .limit(CATALOG_SAFETY_LIMIT);
  const total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No saved workflows yet.",
      data: { items: [], total: 0, returned: 0, offset: 0, has_more: false },
    };
  }
  // Same derived blocks the HTTP/MCP/CLI catalogs show. The fast path
  // queries the tables directly rather than going through `listWorkflows`,
  // so it MUST call the shared categoriser — a second inline rule here is
  // exactly how the surfaces drifted apart before.
  const categories = deriveCategories(rows.map((r) => r.slug));
  const items = rows.map(({ total: _t, ...r }) => ({
    ...r,
    category: categories.get(r.slug) ?? UNCATEGORIZED,
  }));
  const blocks = groupByCategory(items, (r) => r.category);
  const lines = blocks.flatMap((b) => [
    `\n**${b.category}** (${b.items.length})`,
    ...b.items.map((r) => `- ${r.slug} (${r.lifecycle}) — ${r.name}`),
  ]);
  return {
    ok: true,
    reply: `${catalogHeadline("workflow", items.length, total)}${lines.join("\n")}`,
    data: {
      items,
      total,
      returned: items.length,
      offset: 0,
      has_more: items.length < total,
      categories: blocks.map((b) => ({ category: b.category, count: b.items.length })),
    },
  };
}

/** Longest description rendered on one line of a category listing. */
const DESCRIPTION_LINE_MAX = 200;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LINE_MAX
    ? `${flat.slice(0, DESCRIPTION_LINE_MAX - 1).trimEnd()}…`
    : flat;
}

/**
 * Every workflow of ONE derived catalog block, each with what it does.
 *
 * Membership comes from `loadCategoryIndex` — the same whole-catalog corpus
 * the HTTP/MCP/cockpit category counts derive from — so the number of rows
 * here equals the number on the category chip by construction, not through a
 * second rule that could drift. Returns `null` when the block does not exist,
 * so the caller hands the turn to the model instead of answering
 * "0 workflows" for a word that merely sat where a category would.
 */
export async function renderWorkflowCategoryList(
  p: FastPathParams,
  category: string,
  categoryIndex?: ReadonlyMap<string, string>,
): Promise<RenderPayload | null> {
  const index = categoryIndex ?? (await loadCategoryIndex(p.tenant_id, p.db));
  const members = [...index.entries()].filter(([, c]) => c === category).map(([slug]) => slug);
  if (members.length === 0) return null;
  const rows = await p.db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
      description: workflows.description,
      // Same precedence as the `wf_<slug>` tool description (catalog.ts):
      // the editable column, then the active definition's description.
      definition_description: sql<string | null>`${workflowVersions.dag}->>'description'`,
    })
    .from(workflows)
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, p.tenant_id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(
      and(
        eq(workflows.tenant_id, p.tenant_id),
        isNull(workflows.deleted_at),
        inArray(workflows.slug, members),
      ),
    )
    .orderBy(asc(workflows.slug));
  const items = rows.map(({ definition_description, ...r }) => {
    const described = r.description?.trim() || definition_description?.trim() || "";
    return { ...r, category, description: described ? oneLine(described) : null };
  });
  const lines = items.map((r) => {
    const what = r.description && r.description !== r.name ? `: ${r.description}` : "";
    return `- ${r.slug} (${r.lifecycle}) — ${r.name}${what}`;
  });
  return {
    ok: true,
    reply: `${items.length} workflow${items.length === 1 ? "" : "s"} in **${category}**:\n${lines.join("\n")}`,
    data: {
      category,
      items,
      total: items.length,
      returned: items.length,
      offset: 0,
      has_more: false,
    },
  };
}

export async function renderConnectorsList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: connectors.id,
      slug: connectors.slug,
      display_name: connectors.display_name,
      driver: connectors.driver,
      environment: connectors.environment,
      total: totalOverWindow(),
    })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, p.tenant_id), isNull(connectors.deleted_at)))
    .orderBy(asc(connectors.created_at))
    .limit(CATALOG_SAFETY_LIMIT);
  const total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No connectors yet.",
      data: { items: [], total: 0, returned: 0, offset: 0, has_more: false },
    };
  }
  const items = rows.map(({ total: _t, ...r }) => ({ ...r, category: categoryOfConnector(r) }));
  const blocks = groupByCategory(items, (r) => r.category);
  const lines = blocks.flatMap((b) => [
    `\n**${b.category}** (${b.items.length})`,
    ...b.items.map((r) => `- ${r.slug} (${r.environment}) — ${r.display_name}`),
  ]);
  return {
    ok: true,
    reply: `${catalogHeadline("connector", items.length, total)}${lines.join("\n")}`,
    data: {
      items,
      total,
      returned: items.length,
      offset: 0,
      has_more: items.length < total,
      categories: blocks.map((b) => ({ category: b.category, count: b.items.length })),
    },
  };
}

export async function renderExecutionsList(p: FastPathParams): Promise<RenderPayload> {
  // Executions are unbounded history — page, but render from the true
  // total so a page is never presented as the universe.
  const { rows, total } = await listExecutions(p.tenant_id, { limit: EXECUTIONS_PAGE_SIZE }, p.db);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No executions yet.",
      data: { items: [], total: 0, returned: 0, offset: 0, has_more: false },
    };
  }
  const items = rows.map((r) => ({
    id: r.id,
    workflow_id: r.workflow_id,
    status: r.status,
    started_at: r.started_at,
    source_kind: r.source_kind,
  }));
  const lines = items.map(
    (r) =>
      `- ${r.id.slice(0, 8)} ${r.status} (${r.source_kind})${r.started_at ? ` · ${r.started_at.toISOString()}` : ""}`,
  );
  const hasMore = items.length < total;
  const headline = hasMore
    ? `Showing latest ${items.length} of ${total} executions (ask for more or filter by workflow):`
    : `${total} execution${total === 1 ? "" : "s"}:`;
  return {
    ok: true,
    reply: `${headline}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, offset: 0, has_more: hasMore },
  };
}

export async function renderSchedulesList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: workflowsSchedules.id,
      workflow_id: workflowsSchedules.workflow_id,
      cron: workflowsSchedules.cron,
      timezone: workflowsSchedules.timezone,
      paused: workflowsSchedules.paused,
      total: totalOverWindow(),
    })
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.tenant_id, p.tenant_id))
    .orderBy(asc(workflowsSchedules.created_at))
    .limit(CATALOG_SAFETY_LIMIT);
  const total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No schedules yet.",
      data: { items: [], total: 0, returned: 0, offset: 0, has_more: false },
    };
  }
  const items = rows.map(({ total: _t, ...r }) => r);
  const lines = items.map(
    (r) => `- ${r.id.slice(0, 8)} ${r.cron} ${r.timezone}${r.paused ? " (paused)" : ""}`,
  );
  return {
    ok: true,
    reply: `${catalogHeadline("schedule", items.length, total)}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, offset: 0, has_more: items.length < total },
  };
}

export async function renderKnowledgeSourcesList(p: FastPathParams): Promise<RenderPayload> {
  const rows = await p.db
    .select({
      id: knowledgeSources.id,
      slug: knowledgeSources.slug,
      name: knowledgeSources.name,
      source_type: knowledgeSources.source_type,
      total: totalOverWindow(),
    })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), isNull(knowledgeSources.deleted_at)))
    .orderBy(asc(knowledgeSources.created_at))
    .limit(CATALOG_SAFETY_LIMIT);
  const total = Number(rows[0]?.total ?? 0);
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No knowledge sources yet.",
      data: { items: [], total: 0, returned: 0, offset: 0, has_more: false },
    };
  }
  const items = rows.map(({ total: _t, ...r }) => r);
  const lines = items.map((r) => `- ${r.slug} (${r.source_type}) — ${r.name}`);
  return {
    ok: true,
    reply: `${catalogHeadline("knowledge source", items.length, total)}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, offset: 0, has_more: items.length < total },
  };
}
