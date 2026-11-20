import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { taskGrants, tasks } from "../../db/schema/index.ts";
import type { TaskAdmissionReason, TaskGrant } from "../types.ts";
import { type TaskGrantRow, taskGrantView } from "./model.ts";

type GrantRefusal = Extract<
  TaskAdmissionReason,
  "grant_required" | "grant_expired" | "grant_exhausted" | "grant_fingerprint_mismatch" | "paused"
>;

export type TaskGrantReservation =
  | { reserved: true; grant: TaskGrant; exhausted: boolean }
  | { reserved: false; reason: GrantRefusal };

interface GrantRef {
  tenant_id: string;
  grant_id: string;
}

function boundTask(condition: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "tasks" AS bound_task
    WHERE bound_task."tenant_id" = "task_grants"."tenant_id"
      AND bound_task."id" = "task_grants"."task_id"
      AND ${condition}
  )`;
}

function matchesTask(): SQL {
  return boundTask(
    sql`bound_task."fingerprint" = "task_grants"."fingerprint" AND bound_task."environment" = "task_grants"."environment"`,
  );
}

function taskStartable(): SQL {
  return boundTask(sql`bound_task."lifecycle" = 'active' AND bound_task."paused_at" IS NULL`);
}

function withinWindow(): SQL {
  return sql`"task_grants"."valid_from" <= clock_timestamp() AND ("task_grants"."valid_until" IS NULL OR "task_grants"."valid_until" > clock_timestamp())`;
}

function hasRunsLeft(): SQL {
  return sql`("task_grants"."max_runs" IS NULL OR "task_grants"."reserved_runs" < "task_grants"."max_runs")`;
}

export async function taskGrantRefusal(db: Executor, ref: GrantRef): Promise<GrantRefusal | null> {
  const [state] = await db
    .select({
      revoked: sql<boolean>`${taskGrants.revoked_at} IS NOT NULL`,
      within_window: sql<boolean>`${withinWindow()}`,
      runs_left: sql<boolean>`${hasRunsLeft()}`,
      matches_task: sql<boolean>`${matchesTask()}`,
      startable: sql<boolean>`${taskStartable()}`,
    })
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, ref.tenant_id), eq(taskGrants.id, ref.grant_id)))
    .limit(1);
  if (!state || state.revoked) return "grant_required";
  if (!state.matches_task) return "grant_fingerprint_mismatch";
  if (!state.startable) return "paused";
  if (!state.within_window) return "grant_expired";
  if (!state.runs_left) return "grant_exhausted";
  return null;
}

export async function reserveTaskGrantRun(
  tx: Executor,
  ref: GrantRef,
): Promise<TaskGrantReservation> {
  const [row] = await tx
    .update(taskGrants)
    .set({ reserved_runs: sql`${taskGrants.reserved_runs} + 1` })
    .where(
      and(
        eq(taskGrants.tenant_id, ref.tenant_id),
        eq(taskGrants.id, ref.grant_id),
        isNull(taskGrants.revoked_at),
        withinWindow(),
        hasRunsLeft(),
        matchesTask(),
        taskStartable(),
      ),
    )
    .returning();
  if (!row)
    return { reserved: false, reason: (await taskGrantRefusal(tx, ref)) ?? "grant_exhausted" };
  return {
    reserved: true,
    grant: taskGrantView(row),
    exhausted: row.max_runs !== null && row.reserved_runs >= row.max_runs,
  };
}

export async function findUnrevokedTaskGrant(
  db: Executor,
  input: { tenant_id: string; task_id: string },
): Promise<TaskGrant | null> {
  const [row] = await db
    .select({ grant: taskGrants })
    .from(taskGrants)
    .innerJoin(
      tasks,
      and(
        eq(tasks.tenant_id, taskGrants.tenant_id),
        eq(tasks.id, taskGrants.task_id),
        eq(tasks.environment, taskGrants.environment),
      ),
    )
    .where(
      and(
        eq(taskGrants.tenant_id, input.tenant_id),
        eq(taskGrants.task_id, input.task_id),
        isNull(taskGrants.revoked_at),
      ),
    )
    .limit(1);
  return row ? taskGrantView(row.grant as TaskGrantRow) : null;
}
