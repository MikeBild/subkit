// Scheduler test helpers.
//
// The reconciler runs on a ~60s interval in production; tests must NEVER
// wall-clock-wait for it. Instead we drive ONE fan-out pass directly via
// the public `reconcileWorkflowSchedules(now)` method with an injected
// `now`, which makes `isCronDue` deterministic. `seedSchedule` writes the
// `workflows_schedules` row the reconciler reads.

import { and, eq } from "drizzle-orm";
import { executions, workflowsSchedules } from "../../../apps/engine/src/db/schema/index.ts";
import { SchedulerReconciler } from "../../../apps/engine/src/scheduler/reconciler.ts";
import type { E2EEnv } from "../setup.ts";

export interface SeedScheduleOpts {
  /** Cron expression. Default "* * * * *" (every minute) so one pass fires it. */
  cron?: string;
  timezone?: string;
  /** Request payload handed to the fired execution. */
  input?: unknown;
  paused?: boolean;
}

export interface SeededSchedule {
  id: string;
  workflow_id: string;
}

/**
 * Insert a `workflows_schedules` row for an already-seeded workflow. With
 * `last_enqueued_at` left NULL the next reconcile pass treats the schedule
 * as due exactly once (isCronDue returns true on a null last-fired).
 */
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

/**
 * Drive a single workflow-schedule fan-out pass with an injected `now`.
 * Pass a `now` comfortably in the future to force every due cron schedule
 * to fire exactly once. Returns nothing — assert on the executions table /
 * audit log / runtime logs afterward.
 */
export async function runReconcileOnce(env: E2EEnv, now: Date = new Date()): Promise<void> {
  const reconciler = new SchedulerReconciler({ boss: env.boss, db: env.db });
  await reconciler.reconcileWorkflowSchedules(now);
}

/**
 * Find executions a schedule produced — `request_source = "scheduler"`
 * scoped to one workflow. Used to assert the reconcile pass fired the run.
 */
export async function findScheduledExecutions(
  env: E2EEnv,
  workflowId: string,
): Promise<Array<typeof executions.$inferSelect>> {
  return env.db
    .select()
    .from(executions)
    .where(and(eq(executions.workflow_id, workflowId), eq(executions.request_source, "scheduler")));
}
