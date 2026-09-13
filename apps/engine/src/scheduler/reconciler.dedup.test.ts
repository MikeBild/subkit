// Reconciler dedup + time-of-day test.
//
// `reconcileWorkflowSchedules` gates cron-mode schedules with
// `isCronDue(cron, last_enqueued_at, now, tz)` — it enqueues only once
// the cron's next occurrence after the last enqueue has passed. This
// file pins:
//   - a schedule whose last enqueue is inside the current cron interval
//     does NOT re-fire;
//   - once a cron tick has elapsed it fires EXACTLY ONCE (the same pass
//     run twice does not double-fire — the CAS-stamp on
//     `last_enqueued_at` advances the window);
//   - a never-fired schedule fires on the first pass;
//   - a paused schedule never fires;
//   - a `0 19 * * *` schedule honours the wall-clock time-of-day — it is
//     not due at 18:00 and is due after 19:00.
//
// We bypass pg-boss entirely by stubbing `boss.send` and counting
// invocations, isolating the reconciler's enqueue dedup.

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
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";

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
      // All ticks in this suite are fixed historical instants; a fresh
      // schedule is only due once its first cron occurrence after
      // CREATION has passed, so creation must predate every tick.
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
    // now and last are within the same wall-clock minute, so the next
    // `* * * * *` occurrence after `last` has not arrived yet.
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
    // last_enqueued_at must remain unchanged when we skip.
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
      // Two minutes behind — at least one `* * * * *` tick has passed.
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

    // Same pass again at the same instant — last_enqueued_at is now
    // `now`, so the next cron tick has not arrived: no second fire.
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
    // Daily at 19:00 UTC; last fired yesterday at 19:00.
    await insertSchedule(workflow_id, "0 19 * * *", new Date("2026-05-19T19:00:00.000Z"));

    const reconciler = new SchedulerReconciler({ boss, db: ctx.testDb.db, intervalMs: 60_000 });

    // 18:00 today — the next 19:00 occurrence has not arrived: no fire.
    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T18:00:00.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(0);

    // 19:30 today — 19:00 has passed: fires exactly once.
    await reconciler.reconcileWorkflowSchedules(new Date("2026-05-20T19:30:00.000Z"));
    expect(callsFor(calls, workflow_id).length).toBe(1);
  });
});
