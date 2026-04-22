// CRUD helpers over `workflows_schedules`. Intentionally small — the
// SchedulerReconciler polls the table on a 60s cadence so changes here
// take effect within one reconcile window. Unit-testable without
// pg-boss because the table is the source of truth.

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { workflows, workflowsSchedules } from "../db/schema/index.ts";
import { parseCronExpression } from "./cron.ts";

export interface ScheduleRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  cron: string;
  timezone: string;
  paused: boolean;
  input: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface CreateScheduleInput {
  tenant_id: string;
  workflow_id: string;
  cron: string;
  timezone?: string;
  input?: unknown;
  paused?: boolean;
}

export async function createSchedule(db: Db, input: CreateScheduleInput): Promise<ScheduleRow> {
  const parsed = parseCronExpression(input.cron);
  if (!parsed.ok) {
    throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
      code: "invalid_cron",
      reason: parsed.reason,
    });
  }
  // Confirm workflow belongs to tenant before we insert the schedule.
  const wf = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, input.tenant_id), eq(workflows.id, input.workflow_id)))
    .limit(1);
  if (wf.length === 0) {
    throw Object.assign(new Error("workflow_not_found"), { code: "workflow_not_found" });
  }
  const rows = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      paused: input.paused ?? false,
      input: (input.input ?? null) as never,
    })
    .returning();
  return rows[0] as ScheduleRow;
}

export async function listSchedules(
  db: Db,
  tenant_id: string,
  workflow_id?: string,
): Promise<ScheduleRow[]> {
  const conds = [eq(workflowsSchedules.tenant_id, tenant_id)];
  if (workflow_id) conds.push(eq(workflowsSchedules.workflow_id, workflow_id));
  const rows = await db
    .select()
    .from(workflowsSchedules)
    .where(and(...conds));
  return rows as ScheduleRow[];
}

export async function getSchedule(
  db: Db,
  tenant_id: string,
  id: string,
): Promise<ScheduleRow | null> {
  const rows = await db
    .select()
    .from(workflowsSchedules)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .limit(1);
  return (rows[0] as ScheduleRow | undefined) ?? null;
}

export interface UpdateScheduleInput {
  cron?: string;
  timezone?: string;
  paused?: boolean;
  input?: unknown;
}

export async function updateSchedule(
  db: Db,
  tenant_id: string,
  id: string,
  patch: UpdateScheduleInput,
): Promise<ScheduleRow | null> {
  if (patch.cron !== undefined) {
    const parsed = parseCronExpression(patch.cron);
    if (!parsed.ok) {
      throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
        code: "invalid_cron",
        reason: parsed.reason,
      });
    }
  }
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.cron !== undefined) set.cron = patch.cron;
  if (patch.timezone !== undefined) set.timezone = patch.timezone;
  if (patch.paused !== undefined) set.paused = patch.paused;
  if (patch.input !== undefined) set.input = patch.input;
  const rows = await db
    .update(workflowsSchedules)
    .set(set)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .returning();
  return (rows[0] as ScheduleRow | undefined) ?? null;
}

export async function deleteSchedule(db: Db, tenant_id: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(workflowsSchedules)
    .where(and(eq(workflowsSchedules.tenant_id, tenant_id), eq(workflowsSchedules.id, id)))
    .returning({ id: workflowsSchedules.id });
  return rows.length > 0;
}
