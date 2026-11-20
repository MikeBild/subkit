import { and, desc, eq, sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { taskRuns, tasks } from "../../db/schema/index.ts";
import type { TaskRun } from "../types.ts";
import { rowToTaskRun, type TaskScope, taskVisibility } from "./shared.ts";

function runScope(scope: TaskScope) {
  return and(eq(taskRuns.tenant_id, scope.tenant_id), taskVisibility(scope));
}

function taskJoin() {
  return and(eq(tasks.tenant_id, taskRuns.tenant_id), eq(tasks.id, taskRuns.task_id));
}

export async function getTaskRun(
  p: TaskScope & { task_run_id: string },
  db: Executor,
): Promise<TaskRun | null> {
  const [row] = await db
    .select({ run: taskRuns })
    .from(taskRuns)
    .innerJoin(tasks, taskJoin())
    .where(and(runScope(p), eq(taskRuns.id, p.task_run_id)))
    .limit(1);
  return row ? rowToTaskRun(row.run) : null;
}

export async function getTaskRunByConversation(
  p: TaskScope & { conversation_id: string },
  db: Executor,
): Promise<TaskRun | null> {
  const [row] = await db
    .select({ run: taskRuns })
    .from(taskRuns)
    .innerJoin(tasks, taskJoin())
    .where(and(runScope(p), eq(taskRuns.conversation_id, p.conversation_id)))
    .orderBy(desc(taskRuns.created_at))
    .limit(1);
  return row ? rowToTaskRun(row.run) : null;
}

export interface ListTaskRunsParams extends TaskScope {
  task_id: string;
  limit?: number;
  offset?: number;
}

export async function listTaskRuns(p: ListTaskRunsParams, db: Executor): Promise<TaskRun[]> {
  const rows = await db
    .select({ run: taskRuns })
    .from(taskRuns)
    .innerJoin(tasks, taskJoin())
    .where(and(runScope(p), eq(taskRuns.task_id, p.task_id)))
    .orderBy(desc(taskRuns.created_at), desc(taskRuns.id))
    .limit(Math.min(Math.max(p.limit ?? 50, 1), 200))
    .offset(Math.max(p.offset ?? 0, 0));
  return rows.map((row) => rowToTaskRun(row.run));
}

export async function countTaskRuns(p: ListTaskRunsParams, db: Executor): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(taskRuns)
    .innerJoin(tasks, taskJoin())
    .where(and(runScope(p), eq(taskRuns.task_id, p.task_id)))
    .limit(1);
  return row?.total ?? 0;
}
