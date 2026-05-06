// CRUD helpers over `workflows_schedules`. Intentionally small — the
// SchedulerReconciler polls the table on a 60s cadence so changes here
// take effect within one reconcile window. Unit-testable without
// pg-boss because the table is the source of truth.

import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { workflows, workflowsSchedules } from "../db/schema/index.ts";
import type { ScheduleTrigger } from "../workflows/types.ts";
import { parseCronExpression } from "./cron.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// Postgres jsonb returns object keys in storage order (length, then
// lex), not insertion order. JSON.stringify on the round-tripped
// object therefore differs from JSON.stringify on the freshly-built
// payload even when the values are equal — which would make every
// "same trigger" rebind look like an update. Canonicalize before
// comparing.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

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
  // tenant-filter:exempt — cron scheduler sweeps every tenant; row carries tenant_id forward
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

// ------------------ workflow trigger reverse-bind ---------------------
//
// Workflow lifecycle (`apps/engine/src/workflows/service.ts`) calls
// these helpers when a workflow is saved or deleted with a
// `trigger: { kind: "schedule" }` block. The contract mirrors the
// webhooks bind/unbind helpers: idempotent on `(tenant_id,
// workflow_id)`, audit-stamped via `SCHEDULE_TRIGGER_BOUND` /
// `SCHEDULE_TRIGGER_UNBOUND`, and decoupled from the older
// `SCHEDULE_CREATED` / `SCHEDULE_DELETED` actions which stay
// reserved for direct CRUD via the HTTP API.
//
// The reconciler picks up the row on its next 60s pass — there is no
// in-process notification path; the source of truth is the table.

export interface BindScheduleFromWorkflowInput {
  tenant_id: string;
  workflow_id: string;
  trigger: ScheduleTrigger;
  actor_id: string | null;
}

export type BindScheduleOutcome =
  | { status: "created"; row: ScheduleRow }
  | { status: "updated"; row: ScheduleRow }
  | { status: "noop"; row: ScheduleRow };

export async function bindFromWorkflow(
  db: Executor,
  input: BindScheduleFromWorkflowInput,
): Promise<BindScheduleOutcome> {
  const parsed = parseCronExpression(input.trigger.cron);
  if (!parsed.ok) {
    throw Object.assign(new Error(`invalid cron: ${parsed.reason}`), {
      code: "invalid_cron",
      reason: parsed.reason,
    });
  }
  // Stash the calendar gates inside the schedule's `input` payload so
  // they survive without a schema migration. The reconciler in #47
  // honours these on fire; for now they round-trip on the row.
  const inputPayload = {
    business_days_only: input.trigger.business_days_only ?? false,
    skip_dates: input.trigger.skip_dates ?? [],
  };
  const tz = input.trigger.tz;

  const existingRows = await db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, input.tenant_id),
        eq(workflowsSchedules.workflow_id, input.workflow_id),
      ),
    )
    .limit(1);
  const prior = existingRows[0] as ScheduleRow | undefined;

  if (prior) {
    const sameCron = prior.cron === input.trigger.cron;
    const sameTz = prior.timezone === tz;
    const sameInput = canonicalJson(prior.input ?? {}) === canonicalJson(inputPayload);
    if (sameCron && sameTz && sameInput) {
      return { status: "noop", row: prior };
    }
    const updated = await db
      .update(workflowsSchedules)
      .set({
        cron: input.trigger.cron,
        timezone: tz,
        input: inputPayload as never,
        updated_at: new Date(),
      })
      .where(eq(workflowsSchedules.id, prior.id))
      .returning();
    const row = (updated[0] as ScheduleRow | undefined) ?? prior;
    await auditAwait(
      {
        tenant_id: input.tenant_id,
        actor_type: input.actor_id ? "user" : "system",
        actor_id: input.actor_id,
        action: AuditAction.SCHEDULE_TRIGGER_BOUND,
        resource_type: "workflow_schedule",
        resource_id: row.id,
        result: "success",
        metadata: {
          workflow_id: input.workflow_id,
          cron: input.trigger.cron,
          tz,
          business_days_only: input.trigger.business_days_only ?? false,
          skip_date_count: (input.trigger.skip_dates ?? []).length,
          kind: "update",
        },
      },
      db,
    );
    return { status: "updated", row };
  }

  const inserted = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: input.tenant_id,
      workflow_id: input.workflow_id,
      cron: input.trigger.cron,
      timezone: tz,
      paused: false,
      input: inputPayload as never,
    })
    .returning();
  const row = inserted[0] as ScheduleRow;
  await auditAwait(
    {
      tenant_id: input.tenant_id,
      actor_type: input.actor_id ? "user" : "system",
      actor_id: input.actor_id,
      action: AuditAction.SCHEDULE_TRIGGER_BOUND,
      resource_type: "workflow_schedule",
      resource_id: row.id,
      result: "success",
      metadata: {
        workflow_id: input.workflow_id,
        cron: input.trigger.cron,
        tz,
        business_days_only: input.trigger.business_days_only ?? false,
        skip_date_count: (input.trigger.skip_dates ?? []).length,
        kind: "create",
      },
    },
    db,
  );
  return { status: "created", row };
}

/**
 * Reverse-unbind helper called from the workflow delete / version
 * rotate path. Removes every schedule row for the workflow within
 * the tenant scope. Returns the number of rows removed.
 */
export async function unbindFromWorkflow(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  actor_id: string | null,
): Promise<number> {
  const rows = await db
    .delete(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    )
    .returning({ id: workflowsSchedules.id });
  for (const row of rows) {
    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.SCHEDULE_TRIGGER_UNBOUND,
        resource_type: "workflow_schedule",
        resource_id: row.id,
        result: "success",
        metadata: { workflow_id },
      },
      db,
    );
  }
  return rows.length;
}
