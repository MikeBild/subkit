import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { executionStartTraceId } from "../audit/index.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  events,
  executionSteps,
  executions,
  externalCallMetering,
  llmUsage,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { readLlmCost } from "../stats/index.ts";
import { executionVisibilityFilter, executionVisibleToPrincipal } from "./execution-owner.ts";
import {
  type ExecutionListResult,
  type ExecutionRow,
  type ListExecutionsOptions,
  listExecutions,
} from "./list.ts";
import { deriveRerunSafety, loadExecutionOutcome, loadFailureSummaries } from "./outcome.ts";

type ExecutionStepRow = typeof executionSteps.$inferSelect;

interface ExecutionListPage extends ExecutionListResult {
  workflow_names: Map<string, string>;
  failures: Awaited<ReturnType<typeof loadFailureSummaries>>;
  held_execution_ids: Set<string>;
}

export async function listExecutionPage(
  db: Executor,
  principal: ResolvedPrincipal,
  opts: Omit<ListExecutionsOptions, "principal">,
): Promise<ExecutionListPage> {
  const page = await listExecutions(principal.tenant_id, { principal, ...opts }, db);
  const ids = [
    ...new Set(page.rows.map((r) => r.workflow_id).filter((v): v is string => v !== null)),
  ];
  const heldCandidates = page.rows.filter((r) => r.status === "succeeded");
  const [named, failures, heldSteps] = await Promise.all([
    ids.length
      ? db
          .select({ id: workflows.id, name: workflows.name })
          .from(workflows)
          .where(and(eq(workflows.tenant_id, principal.tenant_id), inArray(workflows.id, ids)))
      : Promise.resolve([]),
    loadFailureSummaries(principal.tenant_id, page.rows, db),
    heldCandidates.length
      ? db
          .selectDistinct({ execution_id: executionSteps.execution_id })
          .from(executionSteps)
          .where(
            and(
              eq(executionSteps.tenant_id, principal.tenant_id),
              inArray(
                executionSteps.execution_id,
                heldCandidates.map((r) => r.id),
              ),
              or(
                eq(executionSteps.held, true),
                sql`${executionSteps.request_meta}->'extras'->>'held' = 'true'`,
              ),
            ),
          )
      : Promise.resolve([]),
  ]);
  return {
    ...page,
    workflow_names: new Map(named.map((w) => [w.id, w.name])),
    failures,
    held_execution_ids: new Set(heldSteps.map((step) => step.execution_id)),
  };
}

export async function findOwnedExecution(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<ExecutionRow | null> {
  const rows = await db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  const row = rows[0];
  if (!row || !executionVisibleToPrincipal(row.caller_context, principal)) return null;
  return row;
}

export async function loadExecutionDetail(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<{
  row: ExecutionRow;
  workflow_name: string | null;
  outcome: Awaited<ReturnType<typeof loadExecutionOutcome>>;
  trace_id: Awaited<ReturnType<typeof executionStartTraceId>>;
} | null> {
  const row = await findOwnedExecution(db, principal, execution_id);
  if (!row) return null;
  const [named, outcome, trace_id] = await Promise.all([
    row.workflow_id
      ? db
          .select({ name: workflows.name })
          .from(workflows)
          .where(
            and(eq(workflows.tenant_id, principal.tenant_id), eq(workflows.id, row.workflow_id)),
          )
          .limit(1)
      : Promise.resolve([]),
    loadExecutionOutcome(principal.tenant_id, row, db),
    executionStartTraceId(db, principal.tenant_id, row.id),
  ]);
  return { row, workflow_name: named[0]?.name ?? null, outcome, trace_id };
}

export async function visibleExecutionExists(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, principal.tenant_id),
        eq(executions.id, execution_id),
        executionVisibilityFilter(principal),
      ),
    )
    .limit(1);
  return rows[0] !== undefined;
}

export async function findVisibleExecutionWorkflowId(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<string | null> {
  const rows = await db
    .select({ workflow_id: executions.workflow_id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, principal.tenant_id),
        eq(executions.id, execution_id),
        executionVisibilityFilter(principal),
      ),
    )
    .limit(1);
  return rows[0]?.workflow_id ?? null;
}

export async function findVisibleExecutionRow(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<ExecutionRow | null> {
  const rows = await db
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, principal.tenant_id),
        eq(executions.id, execution_id),
        executionVisibilityFilter(principal),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listVisibleExecutionSteps(
  db: Executor,
  principal: ResolvedPrincipal,
  execution_id: string,
): Promise<ExecutionStepRow[] | null> {
  if (!(await visibleExecutionExists(db, principal, execution_id))) return null;
  return db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, principal.tenant_id),
        eq(executionSteps.execution_id, execution_id),
      ),
    )
    .orderBy(asc(executionSteps.started_at));
}

export function executionStatusEventConditions(tenant_id: string, execution_id: string): SQL[] {
  return [
    eq(events.tenant_id, tenant_id),
    eq(events.channel, "execution.status"),
    sql`${events.payload}->>'execution_id' = ${execution_id}`,
  ];
}

const EMPTY_LLM_TOTALS = {
  calls: 0,
  weighted_tokens: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_read_tokens: 0,
  latency_ms: 0,
};

export const runCacheReadPct = ({
  reported_calls,
  reported_prompt_tokens,
  cache_read_tokens,
}: {
  reported_calls: number;
  reported_prompt_tokens: number;
  cache_read_tokens: number;
}): number | null =>
  reported_calls > 0 && reported_prompt_tokens > 0
    ? Math.round((cache_read_tokens / reported_prompt_tokens) * 1000) / 10
    : null;

export async function loadExecutionCost(
  db: Db,
  principal: ResolvedPrincipal,
  execution_id: string,
) {
  if (!(await visibleExecutionExists(db, principal, execution_id))) return null;
  const llmRows = await db
    .select({
      flow: llmUsage.flow,
      calls: sql<number>`count(*)::int`,
      weighted_tokens: sql<number>`coalesce(sum(${llmUsage.total_tokens}), 0)::int`,
      prompt_tokens: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}), 0)::int`,
      completion_tokens: sql<number>`coalesce(sum(${llmUsage.completion_tokens}), 0)::int`,
      cache_read_tokens: sql<number>`coalesce(sum(${llmUsage.cache_read_tokens}), 0)::int`,
      latency_ms: sql<number>`coalesce(sum(${llmUsage.latency_ms}), 0)::int`,
      reported_calls: sql<number>`(count(*) filter (where ${llmUsage.cache_reported}))::int`,
      reported_prompt_tokens: sql<number>`coalesce(sum(${llmUsage.prompt_tokens}) filter (where ${llmUsage.cache_reported}), 0)::int`,
      reported_cache_read_tokens: sql<number>`coalesce(sum(${llmUsage.cache_read_tokens}) filter (where ${llmUsage.cache_reported}), 0)::int`,
    })
    .from(llmUsage)
    .where(
      and(eq(llmUsage.tenant_id, principal.tenant_id), eq(llmUsage.execution_id, execution_id)),
    )
    .groupBy(llmUsage.flow);

  const cost = await readLlmCost(
    db,
    principal.tenant_id,
    sql`llm_usage.tenant_id = ${principal.tenant_id} and llm_usage.execution_id = ${execution_id}`,
  );

  const by_flow = llmRows.map((r) => ({
    flow: r.flow,
    calls: Number(r.calls),
    weighted_tokens: Number(r.weighted_tokens),
    prompt_tokens: Number(r.prompt_tokens),
    completion_tokens: Number(r.completion_tokens),
    cache_read_tokens: Number(r.cache_read_tokens),
    latency_ms: Number(r.latency_ms),
  }));

  const llm = by_flow.reduce(
    (acc, f) => {
      acc.calls += f.calls;
      acc.weighted_tokens += f.weighted_tokens;
      acc.prompt_tokens += f.prompt_tokens;
      acc.completion_tokens += f.completion_tokens;
      acc.cache_read_tokens += f.cache_read_tokens;
      acc.latency_ms += f.latency_ms;
      return acc;
    },
    { ...EMPTY_LLM_TOTALS },
  );

  const cache_read_pct = runCacheReadPct(
    llmRows.reduce(
      (acc, r) => ({
        reported_calls: acc.reported_calls + Number(r.reported_calls),
        reported_prompt_tokens: acc.reported_prompt_tokens + Number(r.reported_prompt_tokens),
        cache_read_tokens: acc.cache_read_tokens + Number(r.reported_cache_read_tokens),
      }),
      { reported_calls: 0, reported_prompt_tokens: 0, cache_read_tokens: 0 },
    ),
  );

  const extRows = await db
    .select({
      calls: sql<number>`count(*)::int`,
      cost_usd: sql<string>`coalesce(sum(${externalCallMetering.cost_usd}), 0)`,
      units: sql<number>`coalesce(sum(${externalCallMetering.units}), 0)::int`,
      latency_ms: sql<number>`coalesce(sum(${externalCallMetering.latency_ms}), 0)::int`,
    })
    .from(externalCallMetering)
    .where(
      and(
        eq(externalCallMetering.tenant_id, principal.tenant_id),
        eq(externalCallMetering.execution_id, execution_id),
      ),
    );
  const ext = extRows[0];

  return {
    llm: {
      calls: llm.calls,
      weighted_tokens: llm.weighted_tokens,
      prompt_tokens: llm.prompt_tokens,
      completion_tokens: llm.completion_tokens,
      cache_read_tokens: llm.cache_read_tokens,
      cache_read_pct,
      latency_ms: llm.latency_ms,
      by_flow,
      cost,
    },
    external: {
      calls: Number(ext?.calls ?? 0),
      cost_usd: Number(ext?.cost_usd ?? 0),
      units: Number(ext?.units ?? 0),
      latency_ms: Number(ext?.latency_ms ?? 0),
    },
  };
}

export async function loadRerunSafety(
  db: Executor,
  tenant_id: string,
  original: Pick<ExecutionRow, "source_kind" | "workflow_version_id">,
): Promise<ReturnType<typeof deriveRerunSafety>> {
  const version = original.workflow_version_id
    ? await db
        .select({ dag: workflowVersions.dag })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenant_id, tenant_id),
            eq(workflowVersions.id, original.workflow_version_id),
          ),
        )
        .limit(1)
    : [];
  return deriveRerunSafety(original.source_kind, version[0]?.dag ?? null);
}
