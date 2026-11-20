import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import { connectorNeedsReauth } from "../connectors/health-ratio.ts";
import { listConnectors } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { connectors, executionSteps } from "../db/schema/index.ts";
import { taskRuns } from "../db/schema/tasks.ts";
import { aggregateAudit } from "../stats/aggregate-audit.ts";
import { aggregateExecutions } from "../stats/aggregate-executions.ts";
import { aggregateLlm, type LlmGroup } from "../stats/aggregate-llm.ts";
import { statsBucketFor } from "../stats/llm-cost.ts";

export const OPERATING_FIGURES_SCHEMA_VERSION = "operating-figures.v1" as const;

export const DECIDED_REPAIR_ACTIONS = [
  AuditAction.PATCH_CANDIDATE_APPROVED,
  AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
  AuditAction.PATCH_CANDIDATE_REJECTED,
] as const;
const APPLIED_REPAIR_ACTIONS = new Set<string>([
  AuditAction.PATCH_CANDIDATE_APPROVED,
  AuditAction.PATCH_CANDIDATE_AUTO_APPLIED,
]);

export const OPERATING_WINDOWS = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 } as const;
export type OperatingWindow = keyof typeof OPERATING_WINDOWS;

export interface OperatingFigures {
  schema_version: typeof OPERATING_FIGURES_SCHEMA_VERSION;
  window: { from: string; to: string };
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    finished: number;
    success_rate_percent: number | null;
    href: string;
    failed_href: string | null;
  };
  connectors: {
    enabled: number;
    not_ok: number;
    needs_reauth: number;
    healthy_percent: number | null;
    href: string | null;
  };
  repairs: {
    decided: number;
    applied: number;
    applied_percent: number | null;
    href: string;
  };
  prompt_cache: {
    flows: PromptCacheFlow[];
  };
  task_runs: {
    total: number;
    completed: number;
    failed: number;
  };
}

export interface PromptCacheFlow {
  flow: string;
  calls: number;
  prompt_tokens: number;
  cache_read_tokens: number;
  cache_read_percent: number | null;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

function cockpitHref(path: string, query: Record<string, string>): string {
  return `/cockpit${path}?${new URLSearchParams(query).toString()}`;
}

export function promptCacheByFlow(groups: readonly LlmGroup[]): PromptCacheFlow[] {
  return groups
    .filter((group) => group.totals.calls > 0)
    .map((group) => {
      const prompt = group.totals.tokens.prompt;
      const cacheRead = group.totals.tokens.cache_read;
      const share = percent(cacheRead, prompt);
      return {
        flow: group.key.flow ?? "",
        calls: group.totals.calls,
        prompt_tokens: prompt,
        cache_read_tokens: cacheRead,
        cache_read_percent: share === null ? null : Math.min(share, 100),
      };
    })
    .sort((a, b) => b.prompt_tokens - a.prompt_tokens || a.flow.localeCompare(b.flow));
}

export const COCKPIT_RUNS_FILTER_PARAMS = {
  workflowId: "runs_workflow",
  status: "runs_status",
  source: "runs_source",
  q: "runs_q",
  startedFrom: "runs_from",
  startedTo: "runs_to",
} as const;

type CockpitRunsFilter = Partial<Record<keyof typeof COCKPIT_RUNS_FILTER_PARAMS, string>>;

export function cockpitRunsHref(filter: CockpitRunsFilter = {}): string {
  const query: Record<string, string> = { runs: "all" };
  for (const [name, key] of Object.entries(COCKPIT_RUNS_FILTER_PARAMS)) {
    const value = filter[name as keyof CockpitRunsFilter];
    if (value) query[key] = value;
  }
  return cockpitHref("", query);
}

const OPERATING_WINDOW_MAX_MS = 366 * 86_400_000;

export function resolveOperatingBounds(
  input: {
    window?: OperatingWindow | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
  now: Date,
): { ok: true; from: Date; to: Date } | { ok: false; reason: string } {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - OPERATING_WINDOWS[input.window ?? "24h"] * 3_600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, reason: "from and to must be ISO 8601 instants" };
  }
  if (to.getTime() <= from.getTime()) return { ok: false, reason: "to must be after from" };
  if (to.getTime() - from.getTime() > OPERATING_WINDOW_MAX_MS) {
    return { ok: false, reason: "the window spans at most 366 days" };
  }
  return { ok: true, from, to };
}

export async function readOperatingFigures(
  db: Db,
  tenantId: string,
  bounds: { from: Date; to: Date },
): Promise<OperatingFigures> {
  const bucket = statsBucketFor(bounds.from, bounds.to);
  const window = { tenantId, bucket, from: bounds.from, to: bounds.to, tz: "UTC" } as const;
  const [executions, repairs, enabled, notOk, needsReauth, llm, heldSucceeded, taskRunCounts] =
    await Promise.all([
      aggregateExecutions(db, { ...window, groupBy: [] }),
      aggregateAudit(db, {
        ...window,
        actions: [...DECIDED_REPAIR_ACTIONS],
        groupBy: ["action"],
      }),
      listConnectors(tenantId, { enabled: true, limit: 1 }, db),
      listConnectors(tenantId, { health: "not_ok", limit: 1 }, db),
      db
        .select({ total: count() })
        .from(connectors)
        .where(and(eq(connectors.tenant_id, tenantId), connectorNeedsReauth())),
      aggregateLlm(db, { ...window, groupBy: ["flow"] }),
      db.execute(sql`
      select count(distinct ${executionSteps.execution_id})::int as total
      from ${executionSteps}
      inner join executions
        on executions.id = ${executionSteps.execution_id}
        and executions.tenant_id = ${executionSteps.tenant_id}
      where ${executionSteps.tenant_id} = ${tenantId}
        and executions.status = 'succeeded'
        and executions.started_at is not null
        and executions.started_at >= ${bounds.from}
        and executions.started_at < ${bounds.to}
        and (
          ${executionSteps.held} = true
          or ${executionSteps.request_meta}->'extras'->>'held' = 'true'
        )
    `),
      db
        .select({
          total: count(),
          completed: sql<number>`count(*) filter (where ${taskRuns.state} = 'completed')::int`,
          failed: sql<number>`count(*) filter (where ${taskRuns.state} = 'failed')::int`,
        })
        .from(taskRuns)
        .where(
          and(
            eq(taskRuns.tenant_id, tenantId),
            gte(taskRuns.created_at, bounds.from),
            lt(taskRuns.created_at, bounds.to),
          ),
        ),
    ]);

  const total = executions.totals.executions.count;
  const byStatus = executions.totals.executions.by_status;
  const succeeded = Math.max(
    (byStatus.succeeded ?? 0) - Number(heldSucceeded.rows[0]?.total ?? 0),
    0,
  );
  const failed = byStatus.failed ?? 0;
  const finished = Math.max(total - (byStatus.queued ?? 0) - (byStatus.running ?? 0), 0);

  let decided = 0;
  let applied = 0;
  for (const group of repairs.groups) {
    const calls = group.totals.calls.total;
    decided += calls;
    if (APPLIED_REPAIR_ACTIONS.has(group.key.action ?? "")) applied += calls;
  }

  const from = bounds.from.toISOString();
  const to = bounds.to.toISOString();
  const runWindow = { startedFrom: from, startedTo: to };
  return {
    schema_version: OPERATING_FIGURES_SCHEMA_VERSION,
    window: { from, to },
    runs: {
      total,
      succeeded,
      failed,
      finished,
      success_rate_percent: percent(succeeded, finished),
      href: cockpitRunsHref(runWindow),
      failed_href: failed > 0 ? cockpitRunsHref({ status: "failed", ...runWindow }) : null,
    },
    connectors: {
      enabled: enabled.total,
      not_ok: notOk.total,
      needs_reauth: Number(needsReauth[0]?.total ?? 0),
      healthy_percent: percent(Math.max(enabled.total - notOk.total, 0), enabled.total),
      href: notOk.total > 0 ? cockpitHref("/connectors", { health: "not_ok" }) : null,
    },
    repairs: {
      decided,
      applied,
      applied_percent: percent(applied, decided),
      href: cockpitHref("/audit", {
        scope: "all",
        action: DECIDED_REPAIR_ACTIONS.join(","),
        ts_from: from,
        ts_to: to,
      }),
    },
    prompt_cache: { flows: promptCacheByFlow(llm.groups) },
    task_runs: {
      total: Number(taskRunCounts[0]?.total ?? 0),
      completed: Number(taskRunCounts[0]?.completed ?? 0),
      failed: Number(taskRunCounts[0]?.failed ?? 0),
    },
  };
}
