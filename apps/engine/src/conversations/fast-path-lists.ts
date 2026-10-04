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

const DESCRIPTION_LINE_MAX = 200;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LINE_MAX
    ? `${flat.slice(0, DESCRIPTION_LINE_MAX - 1).trimEnd()}…`
    : flat;
}

export type ReplyLanguage = "de" | "en";

const LIFECYCLE_DE: Record<string, string> = {
  draft: "Entwurf",
  active: "aktiv",
  archived: "archiviert",
};

export function categoryListLine(
  row: { slug: string; name: string; lifecycle: string; description: string | null },
  language: ReplyLanguage,
): string {
  const lifecycle =
    language === "de" ? (LIFECYCLE_DE[row.lifecycle] ?? row.lifecycle) : row.lifecycle;
  const parts: string[] = [];
  if (row.name && row.name !== row.slug) parts.push(row.name);
  if (row.description && row.description !== row.name && row.description !== row.slug) {
    parts.push(row.description);
  }
  const what = parts.length > 0 ? ` — ${parts.join(": ")}` : "";
  return `- ${row.slug} (${lifecycle})${what}`;
}

export async function renderWorkflowCategoryList(
  p: FastPathParams,
  category: string,
  categoryIndex?: ReadonlyMap<string, string>,
  language: ReplyLanguage = "en",
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
  const lines = items.map((r) => categoryListLine(r, language));
  const noun =
    language === "de"
      ? items.length === 1
        ? "Workflow"
        : "Workflows"
      : items.length === 1
        ? "workflow"
        : "workflows";
  return {
    ok: true,
    reply: `${items.length} ${noun} in **${category}**:\n${lines.join("\n")}`,
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
  const { rows, total, next_cursor } = await listExecutions(
    p.tenant_id,
    { limit: EXECUTIONS_PAGE_SIZE },
    p.db,
  );
  if (rows.length === 0) {
    return {
      ok: true,
      reply: "No executions yet.",
      data: { items: [], total: 0, returned: 0, next_cursor: null, has_more: false },
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
  const hasMore = next_cursor !== null;
  const headline = hasMore
    ? `Showing latest ${items.length} of ${total} executions (ask for more or filter by workflow):`
    : `${total} execution${total === 1 ? "" : "s"}:`;
  return {
    ok: true,
    reply: `${headline}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, next_cursor, has_more: hasMore },
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
