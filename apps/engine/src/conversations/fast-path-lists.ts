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

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { totalOverWindow } from "../db/list-result.ts";
import { connectors, knowledgeSources, workflows, workflowsSchedules } from "../db/schema/index.ts";
import { listExecutions } from "../execution/list.ts";
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
  const items = rows.map(({ total: _t, ...r }) => r);
  const lines = items.map((r) => `- ${r.slug} (${r.lifecycle}) — ${r.name}`);
  return {
    ok: true,
    reply: `${catalogHeadline("workflow", items.length, total)}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, offset: 0, has_more: items.length < total },
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
  const items = rows.map(({ total: _t, ...r }) => r);
  const lines = items.map((r) => `- ${r.slug} (${r.driver}/${r.environment}) — ${r.display_name}`);
  return {
    ok: true,
    reply: `${catalogHeadline("connector", items.length, total)}\n${lines.join("\n")}`,
    data: { items, total, returned: items.length, offset: 0, has_more: items.length < total },
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
