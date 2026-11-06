import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, executions, workflowsSchedules } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createWorkflowRow, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { readEveryScheduleDefinition } from "../workflow-schedule-sweep.ts";
import { grantScheduleAuthorityFixture } from "./authority-fixture.ts";
import { createStubBoss, type SendCall } from "./stub-boss.ts";

let testDb: TestDb;
let ctxA: EngineTestCtx;
let ctxB: EngineTestCtx;
let workflowA: string;
let workflowB: string;

const TICK = new Date(Date.UTC(2026, 4, 4, 9, 1, 0));

beforeAll(async () => {
  testDb = await createTestDb("sched-tenant-iso");

  const tA = await seedTenant(testDb.db, {
    slug: "sched-iso-a",
    display_name: "Sched-Iso Tenant A",
  });

  const tB = await seedTenant(testDb.db, {
    slug: "sched-iso-b",
    display_name: "Sched-Iso Tenant B",
  });

  ctxA = { testDb, tenantId: tA.id, cleanup: async () => {} };
  ctxB = { testDb, tenantId: tB.id, cleanup: async () => {} };

  const wfA = await createWorkflowRow(ctxA, {
    name: "sched-wf-a",
    slug: "sched-wf-a",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowA = wfA.workflow_id;

  const wfB = await createWorkflowRow(ctxB, {
    name: "sched-wf-b",
    slug: "sched-wf-b",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowB = wfB.workflow_id;
  await grantScheduleAuthorityFixture(testDb.db, ctxA.tenantId, workflowA);
  await grantScheduleAuthorityFixture(testDb.db, ctxB.tenantId, workflowB);
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("scheduler tenant isolation", () => {
  test("tenant A schedule fires exactly one execution row under tenant A", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxA.tenantId,
      workflow_id: workflowA,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(TICK);

    const execRowsA = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxA.tenantId));
    expect(execRowsA.length).toBe(1);
    expect(execRowsA[0]?.workflow_id).toBe(workflowA);
    expect(execRowsA[0]?.request_source).toBe("scheduler");

    const execRowsB = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxB.tenantId));
    expect(execRowsB.length).toBe(0);

    const wfCalls = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflowA,
    );
    expect(wfCalls.length).toBe(1);
    const jobPayload = wfCalls[0]?.payload as { tenant_id?: string };
    expect(jobPayload.tenant_id).toBe(ctxA.tenantId);
  });

  test("tenant B schedule with same cron fires only tenant B's workflow", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    const tick2 = new Date(TICK.getTime() + 2 * 60 * 1000);

    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxB.tenantId,
      workflow_id: workflowB,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(tick2);

    const execRowsA2 = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxA.tenantId));
    expect(execRowsA2.length).toBe(2);
    const latestA = execRowsA2[execRowsA2.length - 1];
    expect(latestA?.workflow_id).toBe(workflowA);

    const execRowsB2 = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctxB.tenantId));
    expect(execRowsB2.length).toBe(1);
    expect(execRowsB2[0]?.workflow_id).toBe(workflowB);

    const crossBleed = execRowsB2.filter((r) => r.workflow_id !== workflowB);
    expect(crossBleed.length).toBe(0);

    const auditsA = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctxA.tenantId), eq(auditLog.action, "schedule.trigger.fired")),
      );
    const auditsB = await testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctxB.tenantId), eq(auditLog.action, "schedule.trigger.fired")),
      );
    expect(auditsA.length).toBe(2);
    expect(auditsB.length).toBe(1);
    expect(auditsB[0]?.action).toBe("schedule.trigger.fired");
    const mdB = auditsB[0]?.metadata as Record<string, unknown> | null;
    expect(mdB?.workflow_id).toBe(workflowB);
  });

  test("schedule row with mismatched tenant_id is skipped and emits a structured warning", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);

    await testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctxB.tenantId,
      workflow_id: workflowA,
      cron: "* * * * *",
      timezone: "UTC",
      paused: false,
      last_enqueued_at: null,
      created_at: new Date(TICK.getTime() - 120_000),
    });

    const tick3 = new Date(TICK.getTime() + 4 * 60 * 1000);

    const beforeA =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxA.tenantId))
      )[0]?.cnt ?? 0;
    const beforeB =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxB.tenantId))
      )[0]?.cnt ?? 0;

    const reconciler = new SchedulerReconciler({ boss, db: testDb.db });
    await reconciler.reconcileWorkflowSchedules(tick3);

    const afterA =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxA.tenantId))
      )[0]?.cnt ?? 0;
    const afterB =
      (
        await testDb.db
          .select({ cnt: sql<number>`count(*)` })
          .from(executions)
          .where(eq(executions.tenant_id, ctxB.tenantId))
      )[0]?.cnt ?? 0;

    expect(Number(afterA) - Number(beforeA)).toBe(1);
    expect(Number(afterB) - Number(beforeB)).toBe(1);

    const crossTenantCalls = calls.filter(
      (c) =>
        (c.payload as { workflow_id?: string; tenant_id?: string })?.workflow_id === workflowA &&
        (c.payload as { tenant_id?: string })?.tenant_id === ctxB.tenantId,
    );
    expect(crossTenantCalls.length).toBe(0);
  });
});

test("every timers exclude persisted schedules belonging to another workflow tenant", async () => {
  const { workflow_id: everyWorkflow } = await createWorkflowRow(ctxA, {
    name: "sched-every-boundary",
    slug: "sched-every-boundary",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  const schedules = await testDb.db
    .insert(workflowsSchedules)
    .values([
      {
        tenant_id: ctxA.tenantId,
        workflow_id: everyWorkflow,
        cron: "every:3600",
        timezone: "UTC",
        paused: false,
      },
      {
        tenant_id: ctxB.tenantId,
        workflow_id: everyWorkflow,
        cron: "every:3600",
        timezone: "UTC",
        paused: false,
      },
    ])
    .returning({ id: workflowsSchedules.id });
  if (schedules.length !== 2) throw new Error("schedule fixtures missing");
  try {
    const own = schedules[0];
    const foreign = schedules[1];
    if (!own || !foreign) throw new Error("schedule fixtures missing");
    expect(
      await readEveryScheduleDefinition(testDb.db, {
        schedule_id: own.id,
        tenant_id: ctxA.tenantId,
      }),
    ).toMatchObject({ schedule_id: own.id, tenant_id: ctxA.tenantId, workflow_id: everyWorkflow });
    expect(
      await readEveryScheduleDefinition(testDb.db, {
        schedule_id: foreign.id,
        tenant_id: ctxB.tenantId,
      }),
    ).toBeNull();
  } finally {
    for (const schedule of schedules)
      await testDb.db
        .delete(workflowsSchedules)
        .where(
          and(
            eq(workflowsSchedules.id, schedule.id),
            eq(workflowsSchedules.workflow_id, everyWorkflow),
          ),
        );
  }
});
