import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db, Executor } from "../db/client.ts";
import { tenants, workflows, workflowsSchedules } from "../db/schema/index.ts";
import { tenantWorkBootId, withTenantWork } from "../execution/index.ts";
import { lockActiveTenant } from "../identity/index.ts";
import { logger } from "../logging/logger.ts";
import type { ExecutionRunJob } from "../queue/queues.ts";
import { calendarGateSkipReason, readCalendarGates, stripCalendarGates } from "./calendar-gates.ts";
import { isCronDue, parseCronExpression } from "./cron.ts";
import type { EveryScheduleDefinition } from "./every-schedule-registry.ts";
import { validateScheduleInput } from "./repo.ts";
import { recordScheduleInputRequired } from "./schedule-admission-state.ts";
import { isScheduleAdmissionHeldError, logScheduleFireFailure } from "./schedule-fire-failure.ts";
import {
  acquireSweepPage,
  boundedTransaction,
  completeSweepEpoch,
  releaseSweepLease,
  type SweepLease,
  walkSweepPage,
  withLiveSweepLease,
} from "./sweep-cursor.ts";

type ScheduleIdentity = { schedule_id: string; tenant_id: string; workflow_id?: string };
export type ScheduleFire = (
  key: string,
  payload: ExecutionRunJob,
  audit: {
    tenant_id: string;
    schedule_id: string;
    tz: string;
    occurrence_after: Date;
    claimed_at: Date;
  },
) => Promise<void>;

export async function readScheduleDescriptor(db: Executor, identity: ScheduleIdentity) {
  const [row] = await db
    .select({
      id: workflowsSchedules.id,
      tenant_id: workflowsSchedules.tenant_id,
      workflow_id: workflowsSchedules.workflow_id,
      cron: workflowsSchedules.cron,
      timezone: workflowsSchedules.timezone,
      execution_mode: workflowsSchedules.execution_mode,
      created_at: workflowsSchedules.created_at,
      last_enqueued_at: workflowsSchedules.last_enqueued_at,
      last_exact: sql<string | null>`${workflowsSchedules.last_enqueued_at}::text`,
      updated_exact: sql<string>`${workflowsSchedules.updated_at}::text`,
    })
    .from(workflowsSchedules)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, workflowsSchedules.workflow_id),
        eq(workflows.tenant_id, workflowsSchedules.tenant_id),
      ),
    )
    .innerJoin(tenants, eq(tenants.id, workflowsSchedules.tenant_id))
    .where(
      and(
        eq(workflowsSchedules.id, identity.schedule_id),
        eq(workflowsSchedules.tenant_id, identity.tenant_id),
        ...(identity.workflow_id ? [eq(workflowsSchedules.workflow_id, identity.workflow_id)] : []),
        eq(workflowsSchedules.paused, false),
        isNull(workflows.deleted_at),
        ne(workflows.lifecycle, "archived"),
        eq(tenants.status, "active"),
        isNull(tenants.deleted_at),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function readEveryScheduleDefinition(
  db: Db,
  identity: ScheduleIdentity,
): Promise<EveryScheduleDefinition | null> {
  return withTenantWork(identity.tenant_id, async () => {
    const row = await boundedTransaction(db, (tx) => readScheduleDescriptor(tx, identity));
    if (!row) return null;
    const parsed = parseCronExpression(row.cron);
    return parsed.ok && parsed.mode === "every" && parsed.everySeconds !== undefined
      ? {
          schedule_id: row.id,
          tenant_id: row.tenant_id,
          workflow_id: row.workflow_id,
          seconds: parsed.everySeconds,
        }
      : null;
  });
}

type Descriptor = NonNullable<Awaited<ReturnType<typeof readScheduleDescriptor>>>;
async function claim(
  tx: Executor,
  row: Descriptor,
  input: unknown,
  now: Date,
  lease?: SweepLease,
): Promise<boolean> {
  await lockActiveTenant(row.tenant_id, tx);
  const updated = await tx
    .update(workflowsSchedules)
    .set({ last_enqueued_at: now })
    .where(
      and(
        eq(workflowsSchedules.id, row.id),
        eq(workflowsSchedules.tenant_id, row.tenant_id),
        eq(workflowsSchedules.workflow_id, row.workflow_id),
        eq(workflowsSchedules.paused, false),
        sql`${workflowsSchedules.updated_at} = ${row.updated_exact}::timestamptz`,
        sql`${workflowsSchedules.last_enqueued_at} IS NOT DISTINCT FROM ${row.last_exact}::timestamptz`,
        sql`COALESCE(${workflowsSchedules.input}, 'null'::jsonb) = ${JSON.stringify(input)}::jsonb`,
        sql`EXISTS (SELECT 1 FROM ${workflows} w WHERE w.id=${row.workflow_id}::uuid AND w.tenant_id=${row.tenant_id}::uuid AND w.deleted_at IS NULL AND w.lifecycle <> 'archived')`,
        ...(lease
          ? [
              sql`${workflowsSchedules.created_at} <= ${lease.epoch_cutoff_at}`,
              sql`${workflowsSchedules.id} <= ${lease.epoch_upper_id}::uuid`,
              ...(lease.after_id ? [sql`${workflowsSchedules.id} > ${lease.after_id}::uuid`] : []),
            ]
          : []),
      ),
    )
    .returning({ id: workflowsSchedules.id });
  if (!updated[0]) return false;
  await auditAwait(
    {
      tenant_id: row.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.SCHEDULE_OCCURRENCE_CLAIMED,
      resource_type: "workflow_schedule",
      resource_id: row.id,
      metadata: { request_source: "scheduler", workflow_id: row.workflow_id },
    },
    tx,
  );
  return true;
}

async function restore(db: Db, row: Descriptor, now: Date): Promise<void> {
  await boundedTransaction(db, async (tx) => {
    const changed = await tx
      .update(workflowsSchedules)
      .set({ last_enqueued_at: sql`${row.last_exact}::timestamptz` })
      .where(
        and(
          eq(workflowsSchedules.id, row.id),
          eq(workflowsSchedules.tenant_id, row.tenant_id),
          eq(workflowsSchedules.workflow_id, row.workflow_id),
          eq(workflowsSchedules.last_enqueued_at, now),
        ),
      )
      .returning({ id: workflowsSchedules.id });
    if (!changed[0]) return;
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.SCHEDULE_OCCURRENCE_RESTORED,
        resource_type: "workflow_schedule",
        resource_id: row.id,
        metadata: { request_source: "scheduler", workflow_id: row.workflow_id },
      },
      tx,
    );
  });
}

async function fireCandidate(
  db: Db,
  identity: ScheduleIdentity,
  now: Date,
  fire: ScheduleFire,
  lease?: SweepLease,
  seconds?: number,
) {
  const row = await boundedTransaction(db, (tx) => readScheduleDescriptor(tx, identity));
  if (!row) return "visited" as const;
  const parsed = parseCronExpression(row.cron);
  if (!parsed.ok) return "visited" as const;
  if (seconds === undefined) {
    if (
      parsed.mode === "every" ||
      !isCronDue(row.cron, row.last_enqueued_at ?? row.created_at, now, row.timezone || "UTC")
    )
      return "visited" as const;
  } else if (
    parsed.mode !== "every" ||
    parsed.everySeconds !== seconds ||
    (row.last_enqueued_at !== null &&
      row.last_enqueued_at.getTime() >= now.getTime() - Math.max(1000, seconds * 1000 * 0.5))
  )
    return "visited" as const;
  const [body] = await boundedTransaction(db, (tx) =>
    tx
      .select({ input: workflowsSchedules.input })
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.id, row.id),
          eq(workflowsSchedules.tenant_id, row.tenant_id),
          eq(workflowsSchedules.workflow_id, row.workflow_id),
          sql`${workflowsSchedules.updated_at} = ${row.updated_exact}::timestamptz`,
        ),
      )
      .limit(1),
  );
  if (!body) return "visited" as const;
  const input = body.input ?? null;
  const inputError = await boundedTransaction(db, (tx) =>
    validateScheduleInput(tx, row.tenant_id, row.workflow_id, input),
  );
  if (inputError) {
    await recordScheduleInputRequired(
      db,
      { tenant_id: row.tenant_id, schedule_id: row.id, observed_at: now },
      inputError,
    );
    return "visited" as const;
  }
  if (
    seconds === undefined &&
    calendarGateSkipReason(now, row.timezone || "UTC", readCalendarGates(input)) !== null
  )
    return "visited" as const;
  const stamped = lease
    ? await withLiveSweepLease(lease, db, (tx) => claim(tx, row, input, now, lease))
    : await boundedTransaction(db, (tx) => claim(tx, row, input, now));
  if (typeof stamped === "object") return "deferred" as const;
  if (!stamped) return "visited" as const;
  try {
    await fire(
      `wf-schedule.${row.id}`,
      {
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        input: stripCalendarGates(input),
        request_source: "scheduler",
        execution_mode: row.execution_mode,
      },
      {
        tenant_id: row.tenant_id,
        schedule_id: row.id,
        tz: row.timezone || "UTC",
        occurrence_after: row.last_enqueued_at ?? row.created_at,
        claimed_at: now,
      },
    );
  } catch (error) {
    if (lease)
      logScheduleFireFailure(
        error,
        { tenant_id: row.tenant_id, workflow_id: row.workflow_id, schedule_id: row.id },
        "schedule.fanout_failed",
      );
    await restore(db, row, now);
    throw error;
  }
  return "admitted" as const;
}

export async function runWorkflowCronSweep(db: Db, now: Date, fire: ScheduleFire): Promise<void> {
  const page = await acquireSweepPage("workflow-cron", tenantWorkBootId(), db);
  if (page.kind !== "claimed") return;
  let lease = page.lease;
  try {
    const walked = await walkSweepPage(page, db, (candidate, handle) =>
      withTenantWork(candidate.tenant_id, async () => {
        try {
          return await fireCandidate(
            db,
            { schedule_id: candidate.id, tenant_id: candidate.tenant_id },
            now,
            fire,
            handle,
          );
        } catch (error) {
          if (
            !isScheduleAdmissionHeldError(error) &&
            !(error instanceof Error && error.name === "AbortError")
          )
            logger.warn({
              module: "scheduler",
              action: "schedule.candidate_failed",
              msg: "schedule candidate did not complete",
              tenant_id: candidate.tenant_id,
              schedule_id: candidate.id,
            });
          throw error;
        }
      }),
    );
    if (walked.kind === "lost_lease") return;
    lease = walked.lease;
    await completeSweepEpoch(lease, db);
  } finally {
    await releaseSweepLease(lease, db);
  }
}

export async function fireEverySchedule(
  db: Db,
  definition: EveryScheduleDefinition,
  fire: ScheduleFire,
): Promise<void> {
  await withTenantWork(definition.tenant_id, () =>
    fireCandidate(db, definition, new Date(), fire, undefined, definition.seconds),
  );
}
