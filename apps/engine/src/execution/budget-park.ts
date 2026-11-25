import { SPEND_LIMIT_REACHED } from "@shared/error-taxonomy.ts";
import { and, eq, isNotNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { readSpend } from "../llm/accounting/spend.ts";
import { logger } from "../logging/index.ts";
import { enqueueHostedWork } from "../queue/hosted-work.ts";
import { EXECUTION_RUN_QUEUE } from "../queue/queues.ts";
import { unregisterAbort } from "./abort.ts";
import { type BudgetPark, parkedScope } from "./core/budget-pause.ts";
import type { RunEnv, RunState } from "./run/env.ts";
import { transitionExecution } from "./state.ts";
import type { RunResult } from "./types.ts";

export const BUDGET_WAIT_MESSAGE =
  "This month's AI budget is reached. The run waits before its model step and continues by itself once the limit is raised, this month is continued or the next month starts.";

async function bossOf(boss: PgBoss | undefined): Promise<PgBoss | null> {
  if (boss) return boss;
  try {
    const { getBoss } = await import("../queue/boss.ts");
    return getBoss();
  } catch {
    return null;
  }
}

export async function enqueueBudgetResume(
  db: Db,
  run: { tenant_id: string; workflow_id: string; execution_id: string },
  startAfter: Date | null,
  boss?: PgBoss,
): Promise<void> {
  const queue = await bossOf(boss);
  if (!queue) return;
  try {
    await enqueueHostedWork(
      db,
      queue,
      "execution",
      EXECUTION_RUN_QUEUE,
      { ...run, budget_resume: true },
      startAfter ? { startAfter } : {},
    );
  } catch (error) {
    logger.warn({
      module: "execution",
      action: "budget_resume.enqueue_failed",
      msg: "a run waiting for the AI budget could not be scheduled to continue",
      tenant_id: run.tenant_id,
      execution_id: run.execution_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function resumeBudgetParkedRuns(
  db: Db,
  tenant_id: string,
  boss?: PgBoss,
): Promise<number> {
  const parked = await db
    .select({ id: executions.id, workflow_id: executions.workflow_id })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, tenant_id),
        eq(executions.status, "queued"),
        isNotNull(executions.budget_park),
      ),
    );
  let enqueued = 0;
  for (const run of parked) {
    if (!run.workflow_id) continue;
    await enqueueBudgetResume(
      db,
      { tenant_id, workflow_id: run.workflow_id, execution_id: run.id },
      null,
      boss,
    );
    enqueued += 1;
  }
  return enqueued;
}

export async function parkRun(env: RunEnv, state: RunState): Promise<RunResult> {
  const park = state.budgetPark;
  if (!park) throw new Error("parkRun called without a budget park");
  const { db, tenant_id, execution_id } = env;
  clearTimeout(env.totalTimer);
  unregisterAbort(execution_id);
  const reading = await readSpend(tenant_id, db, new Date(env.clock.now()));
  const stored: BudgetPark = {
    step_id: park.step_id,
    month: reading.month,
    parked_at: new Date(env.clock.now()).toISOString(),
    scope: parkedScope(state.scope, park.step_id),
  };
  await db
    .update(executionSteps)
    .set({ status: "skipped" })
    .where(and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.id, park.step_row_id)));
  await transitionExecution(db, {
    tenant_id,
    execution_id,
    from: ["running"],
    to: "queued",
    set: { budget_park: stored },
  });
  await auditAwait(
    {
      tenant_id,
      actor_type: "system",
      action: AuditAction.EXECUTION_BUDGET_PARKED,
      resource_type: "execution",
      resource_id: execution_id,
      result: "success",
      metadata: {
        workflow_id: env.resolved.workflow_id,
        step_id: park.step_id,
        month: reading.month,
        continues_at: reading.window.to.toISOString(),
      },
    },
    db,
  );
  if (env.resolved.workflow_id)
    await enqueueBudgetResume(
      db,
      { tenant_id, workflow_id: env.resolved.workflow_id, execution_id },
      reading.window.to,
    );
  return {
    execution_id,
    status: "queued",
    output: null,
    error: { code: SPEND_LIMIT_REACHED, message: BUDGET_WAIT_MESSAGE },
    steps: state.stepSummaries,
  };
}
