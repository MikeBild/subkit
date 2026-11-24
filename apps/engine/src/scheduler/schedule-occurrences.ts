import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  executions,
  type ScheduleOccurrenceRow,
  type ScheduleOccurrenceState,
  scheduleOccurrences,
  taskRuns,
} from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  type OccurrenceRunOutcome,
  type OccurrenceRunRef,
  occurrenceRunOutcomes,
} from "./occurrence-outcome.ts";
import { classifyRun, type DueWindow, planOccurrenceWrite } from "./occurrence-window.ts";

export const SCHEDULE_OCCURRENCE_SKIP_CAP = 100_000;
export const SCHEDULE_OCCURRENCE_RETENTION_DAYS = 90;
export const SCHEDULE_OCCURRENCE_RETENTION_BATCH = 1000;
export const SCHEDULE_OCCURRENCE_PAGE_MAX = 200;

export type OccurrenceSubject =
  | { tenant_id: string; workflow_id: string; schedule_id: string | null }
  | { tenant_id: string; task_id: string };

export interface OccurrenceEntry {
  state: ScheduleOccurrenceState;
  reason_code: string | null;
  started_at?: Date;
  execution_id?: string | null;
  task_run_id?: string | null;
}

export type OccurrenceWindowReader = (after: Date | null) => DueWindow | null;

function subjectFilter(subject: OccurrenceSubject) {
  return and(
    eq(scheduleOccurrences.tenant_id, subject.tenant_id),
    "workflow_id" in subject
      ? eq(scheduleOccurrences.workflow_id, subject.workflow_id)
      : eq(scheduleOccurrences.task_id, subject.task_id),
  );
}

function subjectColumns(subject: OccurrenceSubject) {
  return "workflow_id" in subject
    ? {
        tenant_id: subject.tenant_id,
        workflow_id: subject.workflow_id,
        schedule_id: subject.schedule_id,
      }
    : { tenant_id: subject.tenant_id, task_id: subject.task_id };
}

async function writeOccurrence(
  db: Db,
  subject: OccurrenceSubject,
  entry: OccurrenceEntry,
  window: OccurrenceWindowReader,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [prior] = await tx
      .select({
        id: scheduleOccurrences.id,
        state: scheduleOccurrences.state,
        reason_code: scheduleOccurrences.reason_code,
        last_due_at: scheduleOccurrences.last_due_at,
      })
      .from(scheduleOccurrences)
      .where(subjectFilter(subject))
      .orderBy(desc(scheduleOccurrences.due_at), desc(scheduleOccurrences.created_at))
      .limit(1)
      .for("update");
    const coveredUntil = prior?.last_due_at ?? null;
    if (entry.state === "ran" || entry.state === "ran_late") {
      const started_at = entry.started_at ?? new Date();
      const pendingDue =
        prior && (prior.state === "held" || prior.state === "skipped") ? prior.last_due_at : null;
      const fallbackDue = pendingDue ?? started_at;
      const due = window(coveredUntil) ?? {
        first_due: fallbackDue,
        last_due: fallbackDue,
        count: 1,
      };
      const run = classifyRun(due, started_at);
      await tx.insert(scheduleOccurrences).values({
        ...subjectColumns(subject),
        due_at: due.first_due,
        last_due_at: due.last_due,
        started_at,
        state: run.state,
        reason_code: run.reason_code,
        skipped_count: run.skipped_count,
        execution_id: entry.execution_id ?? null,
        task_run_id: entry.task_run_id ?? null,
      });
      return;
    }
    const plan = planOccurrenceWrite(prior ?? null, entry);
    if (plan.kind === "merge" && prior) {
      const more = window(plan.after);
      if (!more) return;
      await tx
        .update(scheduleOccurrences)
        .set({
          last_due_at: more.last_due,
          skipped_count: sql`LEAST(${scheduleOccurrences.skipped_count} + ${more.count}, ${SCHEDULE_OCCURRENCE_SKIP_CAP})`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(scheduleOccurrences.tenant_id, subject.tenant_id),
            eq(scheduleOccurrences.id, prior.id),
          ),
        );
      return;
    }
    const due = window(coveredUntil);
    if (!due) return;
    await tx.insert(scheduleOccurrences).values({
      ...subjectColumns(subject),
      due_at: due.first_due,
      last_due_at: due.last_due,
      state: entry.state,
      reason_code: entry.reason_code,
      skipped_count: Math.min(due.count, SCHEDULE_OCCURRENCE_SKIP_CAP),
    });
  });
}

export async function recordScheduleOccurrence(
  db: Db,
  subject: OccurrenceSubject,
  entry: OccurrenceEntry,
  window: OccurrenceWindowReader,
): Promise<void> {
  try {
    await writeOccurrence(db, subject, entry, window);
  } catch (error) {
    logger.warn({
      module: "scheduler",
      action: "schedule_occurrence.record_failed",
      msg: "a schedule occurrence was not recorded; the schedule itself is unaffected",
      tenant_id: subject.tenant_id,
      state: entry.state,
      reason_code: entry.reason_code,
      ...errorFields(error),
    });
  }
}

export async function listScheduleOccurrences(
  db: Db,
  subject: { tenant_id: string; workflow_id: string } | { tenant_id: string; task_id: string },
  page: { limit: number; before?: Date },
): Promise<ScheduleOccurrenceRow[]> {
  const limit = Math.max(1, Math.min(page.limit, SCHEDULE_OCCURRENCE_PAGE_MAX));
  return db
    .select()
    .from(scheduleOccurrences)
    .where(
      and(
        eq(scheduleOccurrences.tenant_id, subject.tenant_id),
        "workflow_id" in subject
          ? eq(scheduleOccurrences.workflow_id, subject.workflow_id)
          : eq(scheduleOccurrences.task_id, subject.task_id),
        ...(page.before ? [lt(scheduleOccurrences.due_at, page.before)] : []),
      ),
    )
    .orderBy(desc(scheduleOccurrences.due_at), desc(scheduleOccurrences.created_at))
    .limit(limit);
}

export async function readOccurrenceRunOutcomes(
  db: Db,
  tenant_id: string,
  rows: readonly OccurrenceRunRef[],
): Promise<Map<string, OccurrenceRunOutcome | null>> {
  const executionIds = rows.flatMap((row) => (row.execution_id ? [row.execution_id] : []));
  const taskRunIds = rows.flatMap((row) => (row.task_run_id ? [row.task_run_id] : []));
  const [executionRows, taskRunRows] = await Promise.all([
    executionIds.length === 0
      ? []
      : db
          .select({ id: executions.id, status: executions.status })
          .from(executions)
          .where(and(eq(executions.tenant_id, tenant_id), inArray(executions.id, executionIds))),
    taskRunIds.length === 0
      ? []
      : db
          .select({ id: taskRuns.id, state: taskRuns.state })
          .from(taskRuns)
          .where(and(eq(taskRuns.tenant_id, tenant_id), inArray(taskRuns.id, taskRunIds))),
  ]);
  return occurrenceRunOutcomes(rows, {
    executions: new Map(executionRows.map((row) => [row.id, row.status])),
    task_runs: new Map(taskRunRows.map((row) => [row.id, row.state])),
  });
}

export async function runScheduleOccurrenceRetention(now: Date, db: Db): Promise<number> {
  const cutoff = new Date(
    now.getTime() - SCHEDULE_OCCURRENCE_RETENTION_DAYS * 86_400_000,
  ).toISOString();
  try {
    // tenant-filter:exempt — bounded global retention keys each row by id and tenant and rechecks its age.
    const result = await db.execute(sql`
      WITH candidates AS MATERIALIZED (
        SELECT id,tenant_id FROM subkit.schedule_occurrences
        WHERE created_at < ${cutoff}::timestamptz
        ORDER BY created_at,id
        LIMIT ${SCHEDULE_OCCURRENCE_RETENTION_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM subkit.schedule_occurrences AS occurrences USING candidates
      WHERE occurrences.id=candidates.id AND occurrences.tenant_id=candidates.tenant_id
        AND occurrences.created_at < ${cutoff}::timestamptz
      RETURNING occurrences.id
    `);
    const deleted = result.rows.length;
    logger.info({
      module: "scheduler",
      action: "schedule_occurrence_retention.completed",
      msg: "schedule occurrence retention sweep completed",
      retention_days: SCHEDULE_OCCURRENCE_RETENTION_DAYS,
      deleted,
    });
    return deleted;
  } catch (error) {
    logger.warn({
      module: "scheduler",
      action: "schedule_occurrence_retention.sweep_failed",
      msg: "schedule occurrence retention sweep failed",
      ...errorFields(error),
    });
    return 0;
  }
}
