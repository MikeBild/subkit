import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { taskRuns, tasks } from "../db/schema/index.ts";
import { tenantWorkBootId, withTenantWork } from "../execution/index.ts";
import { withIsolatedContext } from "../logging/context.ts";
import { errorFields, logger } from "../logging/index.ts";
import { recordTaskSweepClaim } from "../observability/task-metrics.ts";
import type { TaskServiceDeps } from "../tasks/index.ts";
import { cronDueWindow, onceDueWindow } from "./occurrence-window.ts";
import { type OccurrenceEntry, recordScheduleOccurrence } from "./schedule-occurrences.ts";
import {
  acquireSweepPage,
  completeSweepEpoch,
  releaseSweepLease,
  walkSweepPage,
} from "./sweep-cursor.ts";

const STALLED_START_MS = 5 * 60_000;

type Tasks = typeof import("../tasks/index.ts");

function scheduledTasks(db: Db, tenant_id: string) {
  return db
    .select({
      id: tasks.id,
      schedule_cron: tasks.schedule_cron,
      schedule_timezone: tasks.schedule_timezone,
      schedule_run_at: tasks.schedule_run_at,
      last_claimed_at: tasks.last_claimed_at,
      schedule_anchor_at: tasks.schedule_anchor_at,
      admission_hold_since: tasks.admission_hold_since,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenant_id, tenant_id),
        eq(tasks.lifecycle, "active"),
        isNull(tasks.paused_at),
        or(isNotNull(tasks.schedule_cron), isNotNull(tasks.schedule_run_at)),
      ),
    )
    .orderBy(asc(tasks.id));
}

type ScheduledTask = Awaited<ReturnType<typeof scheduledTasks>>[number];

async function startDue(
  db: Db,
  api: Tasks,
  tenant_id: string,
  row: ScheduledTask,
  now: Date,
  deps: Partial<TaskServiceDeps>,
): Promise<boolean> {
  const schedule = {
    schedule_cron: row.schedule_cron,
    schedule_timezone: row.schedule_timezone,
    schedule_run_at: row.schedule_run_at?.toISOString() ?? null,
  };
  const trigger = api.taskTriggerFor(schedule);
  if (!trigger) return false;
  const clock = api.taskScheduleClock(row);
  if (!api.isTaskDue(schedule, clock, now)) return false;
  const outcome = await api.startScheduledTaskRun(
    { tenant_id, task_id: row.id, trigger, now },
    db,
    deps,
  );
  const anchor = clock.last_claimed_at ?? clock.anchor;
  const note = (entry: OccurrenceEntry) =>
    recordScheduleOccurrence(db, { tenant_id, task_id: row.id }, entry, (after) => {
      if (row.schedule_run_at) return onceDueWindow(row.schedule_run_at, after, now);
      if (!row.schedule_cron) return null;
      const from = after && after.getTime() > anchor.getTime() ? after : anchor;
      return cronDueWindow(row.schedule_cron, row.schedule_timezone ?? "UTC", from, now);
    });
  if (outcome.admitted) {
    recordTaskSweepClaim({ result: "claimed" });
    await note({ state: "ran", reason_code: null, started_at: now, task_run_id: outcome.run.id });
    return true;
  }
  if ("run" in outcome) recordTaskSweepClaim({ result: "failed" });
  else if (outcome.reason === "not_due") recordTaskSweepClaim({ result: "skipped" });
  else {
    if (outcome.changed) recordTaskSweepClaim({ result: "held" });
    await note({
      state: outcome.reason === "previous_run_active" ? "skipped" : "held",
      reason_code: outcome.reason,
    });
  }
  return false;
}

function candidateFailed(action: string, tenant_id: string, id: string, error: unknown): void {
  logger.warn({
    module: "scheduler",
    action,
    msg: "a task sweep candidate did not complete; the next pass tries again",
    tenant_id,
    candidate_id: id,
    ...errorFields(error),
  });
}

export async function sweepTenantTasks(
  db: Db,
  tenant_id: string,
  now: Date,
  deps: Partial<TaskServiceDeps> = {},
): Promise<number> {
  const api = await import("../tasks/index.ts");
  const driver = await import("../tasks/run-driver.ts");
  let acted = 0;
  acted += (
    await api.failStalledStarts(tenant_id, new Date(now.getTime() - STALLED_START_MS), db, deps)
  ).length;
  for (const row of await scheduledTasks(db, tenant_id)) {
    try {
      if (await startDue(db, api, tenant_id, row, now, deps)) acted++;
    } catch (error) {
      recordTaskSweepClaim({ result: "failed" });
      candidateFailed("task_sweep.start_failed", tenant_id, row.id, error);
    }
  }
  const open = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, tenant_id),
        api.taskRunConversationPrepared(),
        or(
          inArray(taskRuns.state, ["running", "waiting", "sleeping"]),
          and(
            eq(taskRuns.state, "result_ready"),
            sql`EXISTS (
              SELECT 1 FROM conversation_turns turn
               WHERE turn.tenant_id = ${taskRuns.tenant_id}
                 AND turn.conversation_id = ${taskRuns.conversation_id}
                 AND turn.state IN ('completed', 'failed', 'cancelled')
                 AND turn.id IS DISTINCT FROM ${taskRuns.last_seen_turn_id}
                 AND turn.created_at > ${taskRuns.result_ready_at})`,
          ),
        ),
      ),
    )
    .orderBy(asc(taskRuns.id));
  for (const run of open) {
    try {
      const advance = await driver.advanceTaskRun(
        db,
        { tenant_id, task_run_id: run.id, now },
        deps,
      );
      if (advance !== "idle") acted++;
    } catch (error) {
      candidateFailed("task_sweep.advance_failed", tenant_id, run.id, error);
    }
  }
  return acted;
}

export async function runTaskSweep(
  db: Db,
  now: Date = new Date(),
  deps: Partial<TaskServiceDeps> = {},
): Promise<void> {
  const page = await acquireSweepPage("task", tenantWorkBootId(), db);
  if (page.kind !== "claimed") return;
  let lease = page.lease;
  try {
    const walked = await walkSweepPage(page, db, (candidate) =>
      withTenantWork(candidate.tenant_id, () =>
        withIsolatedContext(
          { tenant_id: candidate.tenant_id, request_source: "scheduler", actor_id: "scheduler" },
          async () =>
            (await sweepTenantTasks(db, candidate.tenant_id, now, deps)) > 0
              ? ("admitted" as const)
              : ("visited" as const),
        ),
      ),
    );
    if (walked.kind === "lost_lease") return;
    lease = walked.lease;
    await completeSweepEpoch(lease, db);
  } finally {
    await releaseSweepLease(lease, db);
  }
}
