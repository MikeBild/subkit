import { z } from "@hono/zod-openapi";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { taskGrants, tasks as taskRows, taskRuns } from "../db/schema/index.ts";
import { taskGrantStatus } from "./core/grant.ts";
import { nextTaskStart, type TaskScheduleState, taskScheduleClock } from "./core/schedule.ts";
import { type Task, TaskRunStateSchema, TaskRunWaitingReasonSchema, TaskSchema } from "./types.ts";

const Id = z.string().uuid();
const Timestamp = z.string().datetime({ offset: true });

export const TaskLatestRunSchema = z
  .object({
    id: Id,
    state: TaskRunStateSchema,
    waiting_reason: TaskRunWaitingReasonSchema.nullable(),
    next_check_at: Timestamp.nullable(),
    started_at: Timestamp,
    ended_at: Timestamp.nullable(),
    conversation_id: Id.nullable(),
  })
  .openapi("TaskLatestRun");

export type TaskLatestRun = z.infer<typeof TaskLatestRunSchema>;

export const TaskViewSchema = z
  .object({
    ...TaskSchema.shape,
    latest_run: z.union([TaskLatestRunSchema, z.null()]),
    grant_live: z.boolean(),
    next_start_at: Timestamp.nullable(),
  })
  .openapi("TaskView");

export type TaskView = z.infer<typeof TaskViewSchema>;

export function taskNextStartAt(
  task: Task,
  schedule: Pick<TaskScheduleState, "schedule_anchor_at" | "admission_hold_since">,
): string | null {
  if (task.lifecycle !== "active" || task.paused_at !== null) return null;
  const next = nextTaskStart(
    task,
    taskScheduleClock({
      last_claimed_at: task.last_claimed_at ? new Date(task.last_claimed_at) : null,
      ...schedule,
    }),
  );
  return next ? next.toISOString() : null;
}

async function scheduleStates(db: Executor, tenant_id: string, task_ids: string[]) {
  const rows = await db
    .select({
      id: taskRows.id,
      schedule_anchor_at: taskRows.schedule_anchor_at,
      admission_hold_since: taskRows.admission_hold_since,
    })
    .from(taskRows)
    .where(and(eq(taskRows.tenant_id, tenant_id), inArray(taskRows.id, task_ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

async function latestRuns(
  db: Executor,
  tenant_id: string,
  task_ids: string[],
): Promise<Map<string, TaskLatestRun>> {
  const rows = await db
    .selectDistinctOn([taskRuns.task_id], {
      task_id: taskRuns.task_id,
      id: taskRuns.id,
      state: taskRuns.state,
      waiting_reason: taskRuns.waiting_reason,
      next_check_at: taskRuns.next_check_at,
      created_at: taskRuns.created_at,
      ended_at: taskRuns.ended_at,
      conversation_id: taskRuns.conversation_id,
    })
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, tenant_id), inArray(taskRuns.task_id, task_ids)))
    .orderBy(taskRuns.task_id, desc(taskRuns.created_at), desc(taskRuns.id));
  return new Map(
    rows.map((row) => [
      row.task_id,
      {
        id: row.id,
        state: row.state,
        waiting_reason: row.waiting_reason,
        next_check_at: row.next_check_at?.toISOString() ?? null,
        started_at: row.created_at.toISOString(),
        ended_at: row.ended_at?.toISOString() ?? null,
        conversation_id: row.conversation_id,
      },
    ]),
  );
}

async function liveGrants(
  db: Executor,
  tenant_id: string,
  tasks: Task[],
  now: Date,
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(taskGrants)
    .where(
      and(
        eq(taskGrants.tenant_id, tenant_id),
        inArray(
          taskGrants.task_id,
          tasks.map((task) => task.id),
        ),
        isNull(taskGrants.revoked_at),
      ),
    );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const live = new Set<string>();
  for (const row of rows) {
    const task = byId.get(row.task_id);
    if (
      task &&
      row.environment === task.environment &&
      taskGrantStatus(row, task.fingerprint, now) === "live"
    )
      live.add(task.id);
  }
  return live;
}

export async function withTaskListView(
  db: Executor,
  tenant_id: string,
  tasks: Task[],
  now: Date,
): Promise<TaskView[]> {
  if (tasks.length === 0) return [];
  const ids = tasks.map((task) => task.id);
  const anchors = await scheduleStates(db, tenant_id, ids);
  const [runs, grants] = await Promise.all([
    latestRuns(
      db,
      tenant_id,
      tasks.map((task) => task.id),
    ),
    liveGrants(db, tenant_id, tasks, now),
  ]);
  return tasks.map((task) => ({
    ...task,
    latest_run: runs.get(task.id) ?? null,
    grant_live: task.lifecycle === "active" && grants.has(task.id),
    next_start_at: taskNextStartAt(
      task,
      anchors.get(task.id) ?? {
        schedule_anchor_at: new Date(task.updated_at),
        admission_hold_since: null,
      },
    ),
  }));
}
