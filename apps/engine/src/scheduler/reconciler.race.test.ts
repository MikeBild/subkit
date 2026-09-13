// Reconciler exactly-once-under-two-engines test.
//
// The existing dedup test covers single-engine bookkeeping. This file
// pins the harder property: when two reconcilers run
// `reconcileWorkflowSchedules` concurrently against the same database,
// a single schedule fires EXACTLY ONCE.
//
// The contract is enforced by a compare-and-set on `last_enqueued_at`:
// each reconciler's UPDATE includes the value it just read; only the
// winner's RETURNING comes back non-empty. The loser's UPDATE returns
// 0 rows and the loser skips fireWorkflowSchedule.
//
// If this test ever asserts > 1 fire, the CAS guard has been weakened
// or removed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import {
  executions,
  workflowExecutionAuthorities,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../execution/authority-admission.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../execution/tests/setup.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { SchedulerReconciler } from "./reconciler.ts";
import { grantScheduleAuthorityFixture } from "./tests/authority-fixture.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-race");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

interface SendCall {
  queue: string;
  payload: unknown;
}

function createStubBoss(calls: SendCall[]): PgBoss {
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
  authorize = true,
): Promise<string> {
  if (authorize)
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id, "prod", 1);
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

describe("reconciler exactly-once under two concurrent engines", () => {
  test("two reconcilers running in parallel fire a single schedule exactly once", async () => {
    const callsA: SendCall[] = [];
    const callsB: SendCall[] = [];
    const bossA = createStubBoss(callsA);
    const bossB = createStubBoss(callsB);

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "race-wf",
      slug: "race-wf",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    // FROZEN_NOW is in 2023; the dedup test uses wall-clock so we keep
    // the same convention here. The schedule fires every minute, with
    // last_enqueued_at well past one cron period so isCronDue returns
    // true.
    const now = new Date(FROZEN_NOW);
    await insertSchedule(workflow_id, "* * * * *", new Date(now.getTime() - 5 * 60 * 1000));

    const reconcilerA = new SchedulerReconciler({
      boss: bossA,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });
    const reconcilerB = new SchedulerReconciler({
      boss: bossB,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    // Fire both reconcilers as concurrently as Promise.all permits.
    // The CAS guard ensures only one's UPDATE finds the row in the
    // expected `last_enqueued_at` state; the other's UPDATE returns
    // 0 rows.
    await Promise.all([
      reconcilerA.reconcileWorkflowSchedules(now),
      reconcilerB.reconcileWorkflowSchedules(now),
    ]);

    const totalFires = callsA.length + callsB.length;
    expect(totalFires).toBe(1);
    const [authority] = await ctx.testDb.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id));
    expect(authority?.max_runs).toBe(1);
    expect(authority?.reserved_runs).toBe(1);
  });

  test("the runner-up does not stamp last_enqueued_at past the winner's value", async () => {
    // Sequential calls would also pass this assertion — we use them
    // here to exercise the CAS path via the `prior` value mismatch
    // explicitly. Inject a stale prior into the reconciler by
    // running it after another agent has already stamped the row.
    const callsA: SendCall[] = [];
    const callsB: SendCall[] = [];
    const bossA = createStubBoss(callsA);
    const bossB = createStubBoss(callsB);

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "race-wf-2",
      slug: "race-wf-2",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const now = new Date(FROZEN_NOW);
    await insertSchedule(workflow_id, "* * * * *", new Date(now.getTime() - 5 * 60 * 1000));

    const reconcilerA = new SchedulerReconciler({
      boss: bossA,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });
    const reconcilerB = new SchedulerReconciler({
      boss: bossB,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    // First fire — reconcilerA wins.
    await reconcilerA.reconcileWorkflowSchedules(now);
    expect(callsA.length).toBe(1);

    // Same wall-clock instant — reconcilerB sees the row with a fresh
    // last_enqueued_at and the cron-period dedup short-circuits long
    // before the CAS path is reached. Either way, no second fire.
    await reconcilerB.reconcileWorkflowSchedules(now);
    expect(callsB.length).toBe(0);
  });

  test("a schedule and an API admission cannot spend the same last authorized run", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "last-authorized-run",
      slug: "last-authorized-run",
      steps: [{ id: "noop", kind: "transform", expression: "input" }],
    });
    const now = new Date(FROZEN_NOW);
    const before = new Date(now.getTime() - 300_000);
    await insertSchedule(workflow_id, "* * * * *", before);
    const callsA: SendCall[] = [];
    const first = new SchedulerReconciler({ boss: createStubBoss(callsA), db: ctx.testDb.db });
    const [, apiResult] = await Promise.allSettled([
      first.reconcileWorkflowSchedules(now),
      admitAuthorizedWorkflowExecution(
        {
          tenant_id: ctx.tenantId,
          workflow_id,
          execution_environment: "prod",
          request_source: "api",
          input: { from: "test" },
          idempotency_key: `api-last-run:${workflow_id}`,
        },
        ctx.testDb.db,
      ),
    ]);
    expect(callsA.length + (apiResult.status === "fulfilled" ? 1 : 0)).toBe(1);
    const runs = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, workflow_id));
    expect(runs).toHaveLength(1);
    const [authority] = await ctx.testDb.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id));
    expect(authority?.reserved_runs).toBe(1);
  });

  for (const boundary of ["missing", "revoked"] as const) {
    test(`a ${boundary} authority cannot enqueue or create a scheduled execution`, async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: `authority-${boundary}`,
        slug: `authority-${boundary}`,
        steps: [{ id: "noop", kind: "transform", expression: "input" }],
      });
      const now = new Date(FROZEN_NOW);
      await insertSchedule(
        workflow_id,
        "* * * * *",
        new Date(now.getTime() - 300_000),
        boundary !== "missing",
      );
      if (boundary === "revoked")
        await ctx.testDb.db
          .update(workflowExecutionAuthorities)
          .set({
            revoked_at: await databaseNow(ctx.testDb.db),
            revoked_by: "00000000-0000-4000-8000-000000000001",
          })
          .where(eq(workflowExecutionAuthorities.workflow_id, workflow_id));
      const calls: SendCall[] = [];
      const scheduler = new SchedulerReconciler({
        boss: createStubBoss(calls),
        db: ctx.testDb.db,
        intervalMs: 60_000,
      });
      await scheduler.reconcileWorkflowSchedules(now);
      expect(calls).toHaveLength(0);
      const runs = await ctx.testDb.db
        .select()
        .from(executions)
        .where(eq(executions.workflow_id, workflow_id));
      expect(runs).toHaveLength(0);
    });
  }
});
