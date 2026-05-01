// Reconciler dedup test.
//
// Asserts that `reconcileWorkflowSchedules` honours `last_enqueued_at`:
//   - A `* * * * *` schedule with `last_enqueued_at = now - 30s` does
//     NOT enqueue (one cron period is 60s).
//   - The same schedule with `last_enqueued_at = now - 90s` enqueues
//     EXACTLY ONCE — not twice from the "missed window during 90 s
//     gap" pattern that motivated this fix.
//   - Subsequent passes within the same minute do not double-fire.
//
// We bypass pg-boss entirely by stubbing `boss.send` and counting
// invocations. This isolates the reconciler's enqueue dedup from any
// queue-side dedup pg-boss might also do.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { workflowsSchedules } from "../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { SchedulerReconciler } from "./reconciler.ts";

const TEST_NOW_MS = Date.now();

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-dedup");
});

afterAll(async () => {
  await ctx.cleanup();
});

interface SendCall {
  queue: string;
  payload: unknown;
}

function createStubBoss(calls: SendCall[]): PgBoss {
  // We only exercise `boss.send` from `fireWorkflowSchedule`. Every
  // other method is a no-op so the reconciler's bookkeeping doesn't
  // explode. Cast through `unknown` because we're deliberately
  // stubbing a fraction of the real surface.
  return {
    send: async (queue: string, payload: unknown) => {
      calls.push({ queue, payload });
      return "stub-job-id";
    },
    schedule: async () => undefined,
    unschedule: async () => undefined,
    getQueues: async () => [],
    createQueue: async () => undefined,
    on: () => undefined,
  } as unknown as PgBoss;
}

async function insertSchedule(
  workflow_id: string,
  cron: string,
  last_enqueued_at: Date | null,
): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron,
      timezone: "UTC",
      paused: false,
      input: { from: "test" },
      last_enqueued_at,
    })
    .returning({ id: workflowsSchedules.id });
  if (!row) throw new Error("schedule insert failed");
  return row.id;
}

describe("reconciler workflow-schedule dedup", () => {
  test("skips when last_enqueued_at is within one cron period", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-skip-wf",
      slug: "dedup-skip-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date(TEST_NOW_MS);
    const scheduleId = await insertSchedule(
      workflow_id,
      "* * * * *",
      new Date(now.getTime() - 30_000),
    );

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    // Call the dedup method directly — keeps the test deterministic
    // (no pg-boss ticks, no setInterval drift).
    await reconciler.reconcileWorkflowSchedules(now);

    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(0);

    const after = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    // last_enqueued_at must remain unchanged when we skip.
    expect(after?.last_enqueued_at?.getTime()).toBe(now.getTime() - 30_000);
  });

  test("fires exactly once when last_enqueued_at is past one cron period", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-fire-wf",
      slug: "dedup-fire-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date(TEST_NOW_MS);
    const scheduleId = await insertSchedule(
      workflow_id,
      "* * * * *",
      new Date(now.getTime() - 90_000),
    );

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });

    // First pass at `now` — the 90 s gap should produce ONE enqueue
    // for THIS workflow (not two from a "missed-window" replay).
    await reconciler.reconcileWorkflowSchedules(now);
    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(1);

    const stamped = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    expect(stamped?.last_enqueued_at?.getTime()).toBe(now.getTime());

    // Second pass at `now + 30 s` — still inside the same minute, so
    // dedup says skip.
    await reconciler.reconcileWorkflowSchedules(new Date(now.getTime() + 30_000));
    const callsForWorkflowAfter = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflowAfter.length).toBe(1);
  });

  test("first ever fire (last_enqueued_at NULL) enqueues", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-null-wf",
      slug: "dedup-null-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date(TEST_NOW_MS);
    await insertSchedule(workflow_id, "* * * * *", null);

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });
    await reconciler.reconcileWorkflowSchedules(now);
    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(1);
  });

  test("paused schedule never fires", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "dedup-paused-wf",
      slug: "dedup-paused-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date(TEST_NOW_MS);
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
    await reconciler.reconcileWorkflowSchedules(now);
    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(0);
  });
});
