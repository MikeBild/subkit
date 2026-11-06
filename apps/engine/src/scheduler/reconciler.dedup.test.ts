import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflowsSchedules } from "../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";
import { createStubBoss, type SendCall } from "./tests/stub-boss.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-dedup");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function insertSchedule(
  workflow_id: string,
  cron: string,
  last_enqueued_at: Date | null,
  timezone = "UTC",
): Promise<string> {
  await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
  const [row] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron,
      timezone,
      paused: false,
      input: { from: "test" },
      last_enqueued_at,
      created_at: new Date("2026-05-01T00:00:00.000Z"),
    })
    .returning({ id: workflowsSchedules.id });
  if (!row) throw new Error("schedule insert failed");
  return row.id;
}

function callsFor(calls: SendCall[], workflow_id: string): SendCall[] {
  return calls.filter((c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id);
}

describe("reconciler workflow-schedule dedup", () => {
  test("skips when the last enqueue is inside the current cron interval", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-skip-wf",
      slug: "dedup-skip-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date("2026-05-20T12:30:40.000Z");
    const scheduleId = await insertSchedule(
      workflow_id,
      "* * * * *",
      new Date("2026-05-20T12:30:05.000Z"),
    );

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileWorkflowSchedules(now);

    expect(callsFor(calls, workflow_id).length).toBe(0);

    const after = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    expect(after?.last_enqueued_at?.toISOString()).toBe("2026-05-20T12:30:05.000Z");
  });

  test("fires exactly once when a cron tick has elapsed since the last enqueue", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-fire-wf",
      slug: "dedup-fire-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date("2026-05-20T12:30:40.000Z");
    const scheduleId = await insertSchedule(
      workflow_id,
      "* * * * *",
      new Date("2026-05-20T12:28:40.000Z"),
    );

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });

    await reconciler.reconcileWorkflowSchedules(now);
    expect(callsFor(calls, workflow_id).length).toBe(1);

    const stamped = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    expect(stamped?.last_enqueued_at?.toISOString()).toBe(now.toISOString());

    await reconciler.reconcileWorkflowSchedules(now);
    expect(callsFor(calls, workflow_id).length).toBe(1);
  });

  test("first ever fire (last_enqueued_at NULL) enqueues", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-null-wf",
      slug: "dedup-null-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await insertSchedule(workflow_id, "* * * * *", null);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T12:30:40.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(1);
  });

  test("paused schedule never fires", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-paused-wf",
      slug: "dedup-paused-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const [row] = await ctx.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id,
        cron: "* * * * *",
        timezone: "UTC",
        paused: true,
        input: null,
        last_enqueued_at: null,
      })
      .returning({ id: workflowsSchedules.id });
    expect(row).toBeDefined();

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T12:30:40.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(0);
  });

  test("cron schedule honours wall-clock time-of-day", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-timeofday-wf",
      slug: "dedup-timeofday-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await insertSchedule(workflow_id, "0 19 * * *", new Date("2026-05-19T19:00:00.000Z"));

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });

    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T18:00:00.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(0);

    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T19:30:00.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(1);
  });
});
