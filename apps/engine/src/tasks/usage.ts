import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { taskRuns } from "../db/schema/tasks.ts";
import { type CostResult, currentMonthBucket } from "../llm/index.ts";
import { llmFromClause, readLlmCost } from "../stats/index.ts";

export const TASK_USAGE_PERIODS = ["last_run", "current_month"] as const;
export type TaskUsagePeriod = (typeof TASK_USAGE_PERIODS)[number];

export const TASK_USAGE_NOT_INCLUDED = ["workflow_run_model_calls"] as const;
export const TASK_USAGE_ATTRIBUTIONS = ["conversation_turns", "conversation_removed"] as const;
export type TaskUsageAttribution = (typeof TASK_USAGE_ATTRIBUTIONS)[number];

export interface TaskUsage {
  period: TaskUsagePeriod;
  task_run_id: string | null;
  attribution: TaskUsageAttribution;
  not_included: readonly (typeof TASK_USAGE_NOT_INCLUDED)[number][];
  calls: number;
  tokens: number;
  cost: { amount: number; currency: string; unpriced_models: string[] } | null;
}

type PriceReader = typeof readLlmCost;

function usageFrom(
  period: TaskUsagePeriod,
  task_run_id: string | null,
  attribution: TaskUsageAttribution,
  totals: { calls: number; tokens: number },
  priced: CostResult | null,
): TaskUsage {
  const unpriced = !priced || totals.calls === 0 || priced.unpriced_calls >= totals.calls;
  return {
    period,
    task_run_id,
    attribution,
    not_included: TASK_USAGE_NOT_INCLUDED,
    calls: totals.calls,
    tokens: totals.tokens,
    cost: unpriced
      ? null
      : {
          amount: priced.amount,
          currency: priced.currency,
          unpriced_models: priced.unpriced_models,
        },
  };
}

const NOTHING = { calls: 0, tokens: 0 };

async function runsWithoutConversation(
  db: Db,
  tenantId: string,
  taskId: string,
  now: Date,
): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [row] = await db
    .select({ total: count() })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, tenantId),
        eq(taskRuns.task_id, taskId),
        isNull(taskRuns.conversation_id),
        gte(taskRuns.created_at, from),
        lt(taskRuns.created_at, to),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function taskUsage(
  db: Db,
  tenantId: string,
  taskId: string,
  period: TaskUsagePeriod,
  now: Date,
  price: PriceReader = readLlmCost,
): Promise<TaskUsage> {
  let runId: string | null = null;
  let attribution: TaskUsageAttribution = "conversation_turns";
  if (period === "last_run") {
    const [run] = await db
      .select({ id: taskRuns.id, conversation_id: taskRuns.conversation_id })
      .from(taskRuns)
      .where(and(eq(taskRuns.tenant_id, tenantId), eq(taskRuns.task_id, taskId)))
      .orderBy(desc(taskRuns.created_at), desc(taskRuns.id))
      .limit(1);
    if (!run) return usageFrom(period, null, attribution, NOTHING, null);
    if (!run.conversation_id) {
      return usageFrom(period, run.id, "conversation_removed", NOTHING, null);
    }
    runId = run.id;
  } else if ((await runsWithoutConversation(db, tenantId, taskId, now)) > 0) {
    attribution = "conversation_removed";
  }
  const scope =
    runId === null
      ? sql`llm_usage.month_bucket = ${currentMonthBucket(now)}`
      : sql`task_runs.id = ${runId}`;
  const where = sql`llm_usage.tenant_id = ${tenantId} and task_runs.task_id = ${taskId} and ${scope}`;
  const from = llmFromClause({ taskId });
  const [totals, priced] = await Promise.all([
    db.execute(sql`
      select count(*)::int as calls,
        coalesce(sum(llm_usage.total_tokens), 0)::float8 as tokens
      from ${from}
      where ${where}
    `),
    price(db, tenantId, where, from),
  ]);
  const row = (totals.rows[0] ?? {}) as { calls?: unknown; tokens?: unknown };
  return usageFrom(
    period,
    runId,
    attribution,
    { calls: Number(row.calls ?? 0), tokens: Math.round(Number(row.tokens ?? 0)) },
    priced,
  );
}
