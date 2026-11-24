import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db, Executor } from "../db/client.ts";
import { executions, workflows, workflowsSchedules } from "../db/schema/index.ts";
import { invalidateTenantState } from "../operator/index.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { emitScheduleEvent } from "../webhooks/events/schedule-events.ts";
import { FAILURE_STREAK_WINDOW, type ScheduledRunOutcome } from "./failure-backoff.ts";

export const SCHEDULE_PAUSED_REASON = "repeated_failures" as const;

export function scheduleResumeHref(workflow_id: string): string {
  return `/cockpit/workflows/${encodeURIComponent(workflow_id)}#workflow-automation`;
}

export async function readScheduledRunOutcomes(
  db: Executor,
  schedule: {
    tenant_id: string;
    workflow_id: string;
    execution_mode: "dev" | "prod";
    failures_reset_at: Date | null;
  },
): Promise<ScheduledRunOutcome[]> {
  const ended = sql<Date>`COALESCE(${executions.finished_at}, ${executions.created_at})`;
  const rows = await db
    .select({
      status: executions.status,
      error_code: sql<string | null>`(${executions.failure}->>'error_code')`,
      error_message: sql<string | null>`(${executions.failure}->>'error_message')`,
      finished_at: ended,
    })
    .from(executions)
    .where(
      and(
        eq(executions.tenant_id, schedule.tenant_id),
        eq(executions.workflow_id, schedule.workflow_id),
        eq(executions.request_source, "scheduler"),
        eq(executions.execution_mode, schedule.execution_mode),
        inArray(executions.status, ["failed", "succeeded", "aborted", "timed_out"]),
        ...(schedule.failures_reset_at
          ? [gt(executions.created_at, schedule.failures_reset_at)]
          : []),
      ),
    )
    .orderBy(sql`${ended} DESC`, sql`${executions.id} DESC`)
    .limit(FAILURE_STREAK_WINDOW);
  return rows.map((row) => ({ ...row, finished_at: new Date(row.finished_at) }));
}

export async function pauseScheduleForFailures(
  db: Db,
  schedule: { tenant_id: string; schedule_id: string },
  failure: { failure_class: string; streak: number },
  now: Date,
): Promise<boolean> {
  const paused = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(workflowsSchedules)
      .set({
        paused: true,
        paused_at: now,
        paused_reason: SCHEDULE_PAUSED_REASON,
        paused_failure_class: failure.failure_class,
        paused_failure_count: failure.streak,
        updated_at: now,
      })
      .where(
        and(
          eq(workflowsSchedules.tenant_id, schedule.tenant_id),
          eq(workflowsSchedules.id, schedule.schedule_id),
          eq(workflowsSchedules.paused, false),
        ),
      )
      .returning({
        workflow_id: workflowsSchedules.workflow_id,
        execution_mode: workflowsSchedules.execution_mode,
      });
    if (!row) return false;
    const [workflow] = await tx
      .select({ name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, schedule.tenant_id), eq(workflows.id, row.workflow_id)))
      .limit(1);
    await auditAwait(
      {
        tenant_id: schedule.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULE_PAUSED,
        resource_type: "workflow_schedule",
        resource_id: schedule.schedule_id,
        result: "success",
        reason: SCHEDULE_PAUSED_REASON,
        metadata: {
          request_source: "scheduler",
          workflow_id: row.workflow_id,
          paused_reason: SCHEDULE_PAUSED_REASON,
          failure_class: failure.failure_class,
          consecutive_failures: failure.streak,
          paused_at: now.toISOString(),
        },
      },
      tx,
    );
    await emitScheduleEvent(tx, schedule.tenant_id, "schedule.auto_paused", {
      severity: "error",
      workflow_id: row.workflow_id,
      workflow_name: workflow?.name ?? null,
      schedule_id: schedule.schedule_id,
      environment: row.execution_mode,
      paused_reason: SCHEDULE_PAUSED_REASON,
      failure_class: failure.failure_class,
      consecutive_failures: failure.streak,
      paused_at: now.toISOString(),
      remedy: { kind: "resume", href: scheduleResumeHref(row.workflow_id) },
    });
    await emitResourceChange(tx, {
      tenant_id: schedule.tenant_id,
      type: "workflow.automation_changed",
      ids: { workflow_id: row.workflow_id, schedule_id: schedule.schedule_id },
    });
    return true;
  });
  if (paused) invalidateTenantState(schedule.tenant_id);
  return paused;
}
