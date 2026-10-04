import { and, eq } from "drizzle-orm";
import { executions, workflowsSchedules } from "../../../apps/engine/src/db/schema/index.ts";
import { SchedulerReconciler } from "../../../apps/engine/src/scheduler/reconciler.ts";
import type { E2EEnv } from "../setup.ts";

export interface SeedScheduleOpts {
  cron?: string;
  timezone?: string;
  input?: unknown;
  paused?: boolean;
}

export interface SeededSchedule {
  id: string;
  workflow_id: string;
}

export async function seedSchedule(
  env: E2EEnv,
  workflowId: string,
  opts: SeedScheduleOpts = {},
): Promise<SeededSchedule> {
  const [row] = await env.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: env.tenantId,
      workflow_id: workflowId,
      cron: opts.cron ?? "* * * * *",
      timezone: opts.timezone ?? "UTC",
      paused: opts.paused ?? false,
      input: (opts.input ?? null) as never,
    })
    .returning();
  if (!row) throw new Error("seedSchedule insert returned no row");
  return { id: row.id, workflow_id: workflowId };
}

export async function runReconcileOnce(env: E2EEnv, now: Date = new Date()): Promise<void> {
  const reconciler = new SchedulerReconciler({ boss: env.boss, db: env.db });
  await reconciler.reconcileWorkflowSchedules(now);
}

export async function findScheduledExecutions(
  env: E2EEnv,
  workflowId: string,
): Promise<Array<typeof executions.$inferSelect>> {
  return env.db
    .select()
    .from(executions)
    .where(and(eq(executions.workflow_id, workflowId), eq(executions.request_source, "scheduler")));
}
