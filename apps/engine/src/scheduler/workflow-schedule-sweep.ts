import { isAuthorityRefusalCode } from "@shared/authority-refusal.ts";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db, Executor } from "../db/client.ts";
import { tenants, workflows, workflowsSchedules } from "../db/schema/index.ts";
import { tenantWorkBootId, withTenantWork } from "../execution/index.ts";
import { lockActiveTenant } from "../identity/index.ts";
import { logger } from "../logging/index.ts";
import type { ExecutionRunJob } from "../queue/queues.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";
import {
  calendarGateSkipReason,
  localDateInTz,
  readCalendarGates,
  stripCalendarGates,
} from "./calendar-gates.ts";
import { holdStillStands } from "./core/admission-refusals.ts";
import { isCronDue, parseCronExpression } from "./cron.ts";
import type { EveryScheduleDefinition } from "./every-schedule-registry.ts";
import { assessFailures } from "./failure-backoff.ts";
import {
  cronDueWindow,
  everyDueWindow,
  OCCURRENCE_RECORD_MIN_INTERVAL_MS,
} from "./occurrence-window.ts";
import { getSchedule, validateScheduleInput } from "./repo.ts";
import { recordScheduleInputRequired, recordScheduleRefusal } from "./schedule-admission-state.ts";
import {
  pauseScheduleForFailures,
  readScheduledRunOutcomes,
  SCHEDULE_PAUSED_REASON,
} from "./schedule-failure-pause.ts";
import { isScheduleAdmissionHeldError, logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { type OccurrenceEntry, recordScheduleOccurrence } from "./schedule-occurrences.ts";
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
type ScheduleFire = (
  key: string,
  payload: ExecutionRunJob,
  audit: {
    tenant_id: string;
    schedule_id: string;
    tz: string;
    occurrence_after: Date;
    claimed_at: Date;
  },
) => Promise<{ execution_id: string } | undefined>;

async function readScheduleDescriptor(db: Executor, identity: ScheduleIdentity) {
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
      admission_hold: workflowsSchedules.admission_hold,
      failures_reset_at: workflowsSchedules.failures_reset_at,
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

async function countScheduleRefusal(
  db: Db,
  row: Descriptor,
  reason_code: string,
  now: Date,
): Promise<boolean> {
  const counted = await recordScheduleRefusal(
    db,
    { tenant_id: row.tenant_id, schedule_id: row.id },
    reason_code,
  );
  if (!counted?.pause) return false;
  return pauseScheduleForFailures(
    db,
    { tenant_id: row.tenant_id, schedule_id: row.id },
    { failure_class: reason_code, streak: counted.refusals },
    now,
  );
}

async function remainsAuthorityHeld(db: Db, row: Descriptor): Promise<boolean> {
  const reason_code = row.admission_hold?.reason_code;
  if (!isAuthorityRefusalCode(reason_code)) return false;
  const inspection = await boundedTransaction(db, async (tx) => {
    const schedule = await getSchedule(tx, row.tenant_id, row.id);
    return schedule ? inspectScheduleAutomation(schedule, tx) : null;
  });
  if (!holdStillStands(reason_code, inspection?.state)) return false;
  logger.debug({
    module: "scheduler",
    action: "schedule.admission_still_held",
    msg: "scheduled occurrence stays held until its execution authority changes",
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    schedule_id: row.id,
    reason_code,
  });
  return true;
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
  const tz = row.timezone || "UTC";
  const anchor = row.last_enqueued_at ?? row.created_at;
  const note = (entry: OccurrenceEntry) =>
    recordScheduleOccurrence(
      db,
      { tenant_id: row.tenant_id, workflow_id: row.workflow_id, schedule_id: row.id },
      entry,
      (after) => {
        const from = after && after.getTime() > anchor.getTime() ? after : anchor;
        return seconds === undefined
          ? cronDueWindow(row.cron, tz, from, now)
          : everyDueWindow(seconds, from, now);
      },
    );
  const inputError = await boundedTransaction(db, (tx) =>
    validateScheduleInput(tx, row.tenant_id, row.workflow_id, input),
  );
  if (inputError) {
    await recordScheduleInputRequired(
      db,
      { tenant_id: row.tenant_id, schedule_id: row.id, observed_at: now },
      inputError,
    );
    await note({ state: "held", reason_code: "input_required" });
    return "visited" as const;
  }
  const gatedDueAt =
    seconds === undefined ? (cronDueWindow(row.cron, tz, anchor, now)?.last_due ?? now) : now;
  const gate =
    seconds === undefined ? calendarGateSkipReason(gatedDueAt, tz, readCalendarGates(input)) : null;
  if (gate !== null) {
    logger.debug({
      module: "scheduler",
      action: "schedule.calendar_skipped",
      msg: "scheduled occurrence skipped by its calendar gate",
      tenant_id: row.tenant_id,
      workflow_id: row.workflow_id,
      schedule_id: row.id,
      reason_code: `calendar_${gate}`,
      due_at: gatedDueAt.toISOString(),
      local_date: localDateInTz(gatedDueAt, tz),
    });
    await note({ state: "skipped", reason_code: `calendar_${gate}` });
    return "visited" as const;
  }
  if (await remainsAuthorityHeld(db, row)) {
    const held = row.admission_hold?.reason_code ?? null;
    const paused = held !== null && (await countScheduleRefusal(db, row, held, now));
    await note({ state: "held", reason_code: paused ? SCHEDULE_PAUSED_REASON : held });
    return "visited" as const;
  }
  const failures = assessFailures(
    await boundedTransaction(db, (tx) => readScheduledRunOutcomes(tx, row)),
    now,
  );
  if (failures.action === "pause") {
    if (
      await pauseScheduleForFailures(
        db,
        { tenant_id: row.tenant_id, schedule_id: row.id },
        failures,
        now,
      )
    )
      await note({ state: "held", reason_code: SCHEDULE_PAUSED_REASON });
    return "visited" as const;
  }
  if (failures.action === "backoff") {
    await note({ state: "skipped", reason_code: "failure_backoff" });
    return "visited" as const;
  }
  const stamped = lease
    ? await withLiveSweepLease(lease, db, (tx) => claim(tx, row, input, now, lease))
    : await boundedTransaction(db, (tx) => claim(tx, row, input, now));
  if (typeof stamped === "object") return "deferred" as const;
  if (!stamped) return "visited" as const;
  try {
    const fired = await fire(
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
        tz,
        occurrence_after: anchor,
        claimed_at: now,
      },
    );
    if (seconds === undefined || seconds * 1000 >= OCCURRENCE_RECORD_MIN_INTERVAL_MS)
      await note({
        state: "ran",
        reason_code: null,
        started_at: now,
        execution_id: fired?.execution_id ?? null,
      });
  } catch (error) {
    if (lease)
      logScheduleFireFailure(
        error,
        { tenant_id: row.tenant_id, workflow_id: row.workflow_id, schedule_id: row.id },
        "schedule.fanout_failed",
      );
    await restore(db, row, now);
    if (isScheduleAdmissionHeldError(error)) {
      const paused =
        isAuthorityRefusalCode(error.code) &&
        (await countScheduleRefusal(db, row, error.code, now));
      await note({ state: "held", reason_code: paused ? SCHEDULE_PAUSED_REASON : error.code });
    }
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
