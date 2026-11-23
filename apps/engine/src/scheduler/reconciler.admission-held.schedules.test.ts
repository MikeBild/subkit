import { expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  apiKeys,
  auditLog,
  executions,
  users,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../db/schema/index.ts";
import * as authorityAdmission from "../execution/authority-admission.ts";
import { createWorkflowRow } from "../execution/tests/setup.ts";
import { deactivateUser } from "../identity/provisioning.ts";
import { issueApiKey } from "../identity/service.ts";
import { DomainRefusal } from "../logging/domain-refusal.ts";
import { logger } from "../logging/index.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";
import { REFUSAL_PAUSE_AFTER } from "./core/admission-refusals.ts";
import { ctx, occurrenceAudits, useAdmissionHeldDb } from "./reconciler.admission-held-fixtures.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";
import { fireEverySchedule } from "./workflow-schedule-sweep.ts";

useAdmissionHeldDb();

test("an exhausted authority keeps the schedule held and a live matching one makes it ready", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Exhausted authority schedule",
    slug: "exhausted-authority-schedule",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return input;" }],
  });
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const exhausted = await grantScheduleAuthorityFixture(
    ctx.testDb.db,
    ctx.tenantId,
    workflow_id,
    "prod",
    1,
  );
  await ctx.testDb.db
    .update(workflowExecutionAuthorities)
    .set({ reserved_runs: 1 })
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, ctx.tenantId),
        eq(workflowExecutionAuthorities.id, exhausted.id),
      ),
    );
  expect(await inspectScheduleAutomation(schedule, ctx.testDb.db)).toMatchObject({
    state: "approval_required",
    ready: false,
  });
  const refusal = await authorityAdmission
    .admitSystemWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id,
        request_source: "scheduler",
        execution_environment: "prod",
        input: null,
      },
      ctx.testDb.db,
    )
    .catch((caught: unknown) => caught);
  expect(refusal).toBeInstanceOf(DomainRefusal);
  expect(refusal).toMatchObject({ code: "execution_authority_exhausted" });
  await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
  expect(await inspectScheduleAutomation(schedule, ctx.testDb.db)).toMatchObject({
    state: "authorized",
    ready: true,
  });
});

test("a held every-schedule is not claimed, fired or warned on repeated ticks", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Held every schedule",
    slug: "held-every-schedule",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return input;" }],
  });
  const hold = {
    reason_code: "execution_authority_expired" as const,
    observed_at: "2026-05-01T00:00:00.000Z",
  };
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "every:60",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
      admission_hold: hold,
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const fired: string[] = [];
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (let tick = 0; tick < 3; tick++)
      await fireEverySchedule(
        ctx.testDb.db,
        { schedule_id: schedule.id, tenant_id: ctx.tenantId, workflow_id, seconds: 60 },
        async (key) => {
          fired.push(key);
        },
      );
    expect(fired).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(await occurrenceAudits(schedule.id)).toEqual({ claimed: 0, restored: 0 });
    const [held] = await ctx.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(eq(workflowsSchedules.id, schedule.id), eq(workflowsSchedules.tenant_id, ctx.tenantId)),
      );
    expect(held?.last_enqueued_at).toBeNull();
    expect(held?.admission_hold).toEqual({ ...hold, refusals: 3 });
  } finally {
    warn.mockRestore();
  }
});

test("a schedule refused for the same reason again and again pauses and says why", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Refused every schedule",
    slug: "refused-every-schedule",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return input;" }],
  });
  const hold = {
    reason_code: "execution_authority_revoked" as const,
    observed_at: "2026-05-01T00:00:00.000Z",
  };
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "every:60",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
      admission_hold: hold,
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  const fired: string[] = [];
  const read = async () =>
    (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.id, schedule.id),
            eq(workflowsSchedules.tenant_id, ctx.tenantId),
          ),
        )
    )[0];
  const tick = () =>
    fireEverySchedule(
      ctx.testDb.db,
      { schedule_id: schedule.id, tenant_id: ctx.tenantId, workflow_id, seconds: 60 },
      async (key) => {
        fired.push(key);
      },
    );
  for (let seen = 1; seen < REFUSAL_PAUSE_AFTER; seen++) {
    await tick();
    expect(await read()).toMatchObject({
      paused: false,
      admission_hold: { ...hold, refusals: seen },
    });
  }
  await tick();
  expect(await read()).toMatchObject({
    paused: true,
    paused_reason: "repeated_failures",
    paused_failure_class: "execution_authority_revoked",
    paused_failure_count: REFUSAL_PAUSE_AFTER,
    admission_hold: hold,
  });
  await tick();
  expect(fired).toHaveLength(0);
  expect((await read())?.admission_hold).toEqual(hold);
  const paused = await ctx.testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "schedule.paused"),
        eq(auditLog.resource_id, schedule.id),
      ),
    );
  expect(paused).toHaveLength(1);
  expect(paused[0]?.metadata).toMatchObject({
    failure_class: "execution_authority_revoked",
    consecutive_failures: REFUSAL_PAUSE_AFTER,
  });
});

test("a schedule waiting for its first approval keeps waiting and never pauses", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Waiting for a first approval",
    slug: "waiting-for-first-approval",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return input;" }],
  });
  const hold = {
    reason_code: "execution_authority_required" as const,
    observed_at: "2026-05-01T00:00:00.000Z",
  };
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "every:60",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date("2026-05-01T00:00:00Z"),
      admission_hold: hold,
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  for (let seen = 0; seen < REFUSAL_PAUSE_AFTER * 2; seen++) {
    await fireEverySchedule(
      ctx.testDb.db,
      { schedule_id: schedule.id, tenant_id: ctx.tenantId, workflow_id, seconds: 60 },
      async () => {},
    );
  }
  const [after] = await ctx.testDb.db
    .select()
    .from(workflowsSchedules)
    .where(
      and(eq(workflowsSchedules.id, schedule.id), eq(workflowsSchedules.tenant_id, ctx.tenantId)),
    );
  expect(after).toMatchObject({ paused: false, paused_reason: null, admission_hold: hold });
  expect(after?.admission_hold).not.toHaveProperty("refusals");
});

test("deactivating a person revokes their key while an approved schedule still runs as system", async () => {
  const [person] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "deactivated-scheduler-user@test.local",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning();
  if (!person) throw new Error("fixture user missing");
  const key = await issueApiKey(
    {
      issuer: { kind: "system" },
      tenant_id: ctx.tenantId,
      owner_kind: "user",
      owner_id: person.id,
      actor_id: null,
    },
    ctx.testDb.db,
  );
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "System-owned after person deactivation",
    slug: "system-owned-after-person-deactivation",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  const now = await databaseNow(ctx.testDb.db);
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(now.getTime() - 5 * 60_000),
    })
    .returning();
  if (!schedule) throw new Error("fixture schedule missing");
  await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);

  await deactivateUser(
    { tenant_id: ctx.tenantId, user_id: person.id, actor_id: null },
    ctx.testDb.db,
  );

  const [revokedKey] = await ctx.testDb.db
    .select({ revoked_at: apiKeys.revoked_at })
    .from(apiKeys)
    .where(eq(apiKeys.id, key.view.id));
  expect(revokedKey?.revoked_at).toBeInstanceOf(Date);
  const scheduleWhere = and(
    eq(workflowsSchedules.id, schedule.id),
    eq(workflowsSchedules.tenant_id, ctx.tenantId),
  );
  const [retainedSchedule] = await ctx.testDb.db
    .select()
    .from(workflowsSchedules)
    .where(scheduleWhere);
  expect(retainedSchedule).toMatchObject({
    id: schedule.id,
    workflow_id,
    cron: "* * * * *",
    timezone: "UTC",
    paused: false,
    last_enqueued_at: null,
  });

  const sent: Array<{ queue: string; payload: Record<string, unknown> }> = [];
  const boss = {
    send: async (queue: string, payload: Record<string, unknown>) => {
      sent.push({ queue, payload });
      return "job";
    },
  } as unknown as PgBoss;
  await new SchedulerReconciler({ boss, db: ctx.testDb.db }).reconcileWorkflowSchedules(now);
  const personIndependentRuns = sent.filter((job) => job.payload.workflow_id === workflow_id);
  expect(personIndependentRuns).toHaveLength(1);
  expect(personIndependentRuns[0]?.payload).toMatchObject({
    tenant_id: ctx.tenantId,
    workflow_id,
    request_source: "scheduler",
    execution_mode: "prod",
  });
  expect(personIndependentRuns[0]?.payload).not.toHaveProperty("caller_origin");
  const [execution] = await ctx.testDb.db
    .select({ caller_origin: executions.caller_origin, caller_context: executions.caller_context })
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)));
  expect(execution).toEqual({ caller_origin: "trusted_system", caller_context: null });
  const [fired] = await ctx.testDb.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "schedule.trigger.fired"),
        eq(auditLog.resource_id, schedule.id),
      ),
    );
  expect(fired).toEqual({ actor_type: "system", actor_id: null });
});

test("technical failures and lookalike messages remain errors", () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    for (const failure of [
      new Error("queue unavailable"),
      new Error("this workflow requires concrete-run review for its current effects"),
      Object.assign(new Error("invalid input"), { code: "input_schema_violation" }),
    ]) {
      logScheduleFireFailure(
        failure,
        { tenant_id: ctx.tenantId, workflow_id: "workflow", schedule_id: "schedule" },
        "schedule.fanout_failed",
      );
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(3);
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});

test("integrity refusals outside held authority stay ordinary coded errors", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Integrity refusal",
    slug: "integrity-refusal",
    steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "return input;" }],
  });
  const refusal = await authorityAdmission
    .admitSystemWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id,
        workflow_version_id: "00000000-0000-4000-8000-000000000000",
        request_source: "scheduler",
        execution_environment: "prod",
        input: null,
      },
      ctx.testDb.db,
    )
    .catch((caught: unknown) => caught);
  expect(refusal).toMatchObject({ code: "workflow_version_not_active" });
  expect(refusal).not.toBeInstanceOf(DomainRefusal);
});
