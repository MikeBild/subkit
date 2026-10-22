import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
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
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { deactivateUser } from "../identity/provisioning.ts";
import { issueApiKey } from "../identity/service.ts";
import { DomainRefusal } from "../logging/domain-refusal.ts";
import { logger } from "../logging/logger.ts";
import {
  getOperationalOverview,
  invalidateOperationalOverview,
} from "../operator/operational-overview.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { registerExecutionRunHandler } from "../queue/handlers/execution-run.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { waitFor } from "../test-helpers/determinism/wait.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { recordScheduleAdmission } from "./schedule-admission-state.ts";
import { logScheduleFireFailure } from "./schedule-fire-failure.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";
import { fireEverySchedule } from "./workflow-schedule-sweep.ts";

let ctx: EngineTestCtx;
beforeAll(async () => {
  ctx = await createEngineCtx("schedule-admission-held");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function occurrenceAudits(schedule_id: string) {
  const rows = await ctx.testDb.db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.resource_id, schedule_id),
        inArray(auditLog.action, ["schedule.occurrence_claimed", "schedule.occurrence_restored"]),
      ),
    );
  return {
    claimed: rows.filter((row) => row.action === "schedule.occurrence_claimed").length,
    restored: rows.filter((row) => row.action === "schedule.occurrence_restored").length,
  };
}

function admissionHeldWarns(warn: { mock: { calls: unknown[][] } }) {
  return warn.mock.calls.filter(
    (call) => (call[0] as { action?: string } | undefined)?.action === "schedule.admission_held",
  );
}

test("missing authority stays held without re-claiming; later approval admits exactly one run", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Held schedule",
    slug: "held-schedule",
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
  const sent: unknown[] = [];
  const gateJobs: unknown[] = [];
  const executionBoss = await createBoss({ connectionString: ctx.testDb.url });
  const boss = {
    send: async (queue: string, payload: unknown) => {
      (queue === "workflow.repair" ? gateJobs : sent).push(payload);
      return queue === "workflow.repair" ? "job" : executionBoss.send(queue, payload as object);
    },
  } as unknown as PgBoss;
  const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  const admit = spyOn(authorityAdmission, "admitSystemWorkflowExecution");
  const now = new Date("2026-06-05T12:00:00Z");
  const later = new Date(now.getTime() + 180_000);
  const scheduleWhere = and(
    eq(workflowsSchedules.id, schedule.id),
    eq(workflowsSchedules.tenant_id, ctx.tenantId),
  );
  try {
    for (const offset of [0, 60_000, 120_000])
      await reconciler.reconcileWorkflowSchedules(new Date(now.getTime() + offset));
    expect(sent).toHaveLength(0);
    expect(gateJobs).toEqual([
      expect.objectContaining({ workflow_id, trigger: "gate_block", environment: "prod" }),
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await occurrenceAudits(schedule.id)).toEqual({ claimed: 1, restored: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      action: "schedule.admission_held",
      tenant_id: ctx.tenantId,
      workflow_id,
      schedule_id: schedule.id,
      reason_code: "execution_authority_unavailable",
    });
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.last_enqueued_at,
    ).toBeNull();
    expect(
      await ctx.testDb.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)),
        ),
    ).toHaveLength(0);
    const held = (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0];
    expect(held?.admission_hold).toEqual({
      reason_code: "execution_authority_unavailable",
      observed_at: now.toISOString(),
    });
    invalidateOperationalOverview(ctx.tenantId);
    const overview = await getOperationalOverview(ctx.testDb.db, ctx.tenantId);
    expect(overview.core.blocked.value).toBe(1);
    expect(overview.core.health.state).toBe("critical");
    expect(overview.core.health.severity).toBe("critical");
    expect(overview.core.health.value).toBeNull();
    const changes = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "schedule.admission.changed"),
        ),
      );
    expect(changes).toHaveLength(1);
    await ctx.testDb.db.update(workflowsSchedules).set({ paused: true }).where(scheduleWhere);
    invalidateOperationalOverview(ctx.tenantId);
    expect((await getOperationalOverview(ctx.testDb.db, ctx.tenantId)).core.blocked.value).toBe(0);
    await ctx.testDb.db.update(workflowsSchedules).set({ paused: false }).where(scheduleWhere);
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
    await reconciler.reconcileWorkflowSchedules(later);
    await reconciler.reconcileWorkflowSchedules(later);
    expect(sent).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(2);
    const admittedRuns = await ctx.testDb.db
      .select({
        id: executions.id,
        status: executions.status,
        caller_origin: executions.caller_origin,
        caller_context: executions.caller_context,
        idempotency_key: executions.idempotency_key,
      })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)));
    expect(admittedRuns).toHaveLength(1);
    expect(admittedRuns[0]).toMatchObject({
      status: "queued",
      caller_origin: "trusted_system",
      caller_context: null,
      idempotency_key: `schedule:${schedule.id}:after:${schedule.created_at.toISOString()}`,
    });
    const admissionChanges = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, schedule.id),
          eq(auditLog.action, "schedule.admission.changed"),
        ),
      )
      .orderBy(auditLog.ts);
    expect(admissionChanges.map((row) => (row.metadata as { state?: string }).state)).toEqual([
      "held",
      "admitted",
    ]);
    const executionId = admittedRuns[0]?.id;
    if (!executionId) throw new Error("admitted schedule execution missing");
    await registerExecutionRunHandler({ boss: executionBoss, db: ctx.testDb.db });
    const completed = await waitFor(
      async () => {
        const [row] = await ctx.testDb.db
          .select()
          .from(executions)
          .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
        if (!row || ["queued", "running"].includes(row.status)) return null;
        const terminalAudit = await ctx.testDb.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenant_id, ctx.tenantId),
              eq(auditLog.resource_id, executionId),
              eq(auditLog.action, "execution.completed"),
            ),
          );
        return terminalAudit.length ? row : null;
      },
      { tries: 150, sleepMs: 200, label: "scheduled system execution" },
    );
    expect(completed).toMatchObject({
      status: "succeeded",
      caller_origin: "trusted_system",
      caller_context: null,
    });
    const lifecycle = await ctx.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, executionId)));
    for (const action of ["execution.started", "execution.completed"]) {
      expect(lifecycle.filter((entry) => entry.action === action)).toEqual([
        { action, actor_type: "system", actor_id: null },
      ]);
    }
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.admission_hold,
    ).toBeNull();
    await recordScheduleAdmission(
      ctx.testDb.db,
      { tenant_id: ctx.tenantId, schedule_id: schedule.id, claimed_at: later },
      "execution_authority_required",
    );
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.admission_hold,
    ).toBeNull();
    await recordScheduleAdmission(
      ctx.testDb.db,
      {
        tenant_id: ctx.tenantId,
        schedule_id: schedule.id,
        claimed_at: new Date(later.getTime() - 1),
      },
      "execution_authority_required",
    );
    await recordScheduleAdmission(
      ctx.testDb.db,
      {
        tenant_id: "00000000-0000-4000-8000-000000000000",
        schedule_id: schedule.id,
        claimed_at: later,
      },
      "execution_authority_required",
    );
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.admission_hold,
    ).toBeNull();
    invalidateOperationalOverview(ctx.tenantId);
    expect((await getOperationalOverview(ctx.testDb.db, ctx.tenantId)).core.blocked.value).toBe(0);
    expect(
      (await ctx.testDb.db.select().from(workflowsSchedules).where(scheduleWhere))[0]
        ?.last_enqueued_at,
    ).toEqual(later);
    expect(error).not.toHaveBeenCalled();
  } finally {
    admit.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    await disposeBoss(executionBoss);
  }
});

test("dynamic effects require concrete review, stay out of the queue and are not re-attempted", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Dynamic schedule",
    slug: "dynamic-held-schedule",
    steps: [{ id: "send", kind: "request", method: "POST", url: "$input.url" }],
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
  const sent: unknown[] = [];
  const gateJobs: unknown[] = [];
  const boss = {
    send: async (queue: string, payload: unknown) => {
      (queue === "workflow.repair" ? gateJobs : sent).push(payload);
      return "job";
    },
  } as unknown as PgBoss;
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const error = spyOn(logger, "error").mockImplementation(() => {});
  const admit = spyOn(authorityAdmission, "admitSystemWorkflowExecution");
  const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db });
  const now = new Date("2026-06-05T12:00:00Z");
  try {
    for (const offset of [0, 60_000, 120_000])
      await reconciler.reconcileWorkflowSchedules(new Date(now.getTime() + offset));
    expect(sent).toHaveLength(0);
    expect(gateJobs).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await occurrenceAudits(schedule.id)).toEqual({ claimed: 1, restored: 1 });
    expect(admissionHeldWarns(warn)).toHaveLength(1);
    expect(
      await ctx.testDb.db
        .select({ id: executions.id })
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflow_id)),
        ),
    ).toHaveLength(0);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      action: "schedule.admission_held",
      reason_code: "execution_authority_required",
      schedule_id: schedule.id,
    });
    expect(
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
      )[0]?.last_enqueued_at,
    ).toBeNull();
  } finally {
    admit.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
});

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
  expect(refusal).toMatchObject({ code: "execution_authority_unavailable" });
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
    reason_code: "execution_authority_unavailable" as const,
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
    expect(held?.admission_hold).toEqual(hold);
  } finally {
    warn.mockRestore();
  }
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
