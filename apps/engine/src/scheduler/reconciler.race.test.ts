import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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
import { createStubBoss, type SendCall } from "./tests/stub-boss.ts";

const IGNORED_QUEUES: ReadonlySet<string> = new Set(["workflow.repair"]);

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-race");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

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
      created_at: last_enqueued_at ?? new Date(FROZEN_NOW),
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
    const bossA = createStubBoss(callsA, IGNORED_QUEUES);
    const bossB = createStubBoss(callsB, IGNORED_QUEUES);

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "race-wf",
      slug: "race-wf",
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
    const callsA: SendCall[] = [];
    const callsB: SendCall[] = [];
    const bossA = createStubBoss(callsA, IGNORED_QUEUES);
    const bossB = createStubBoss(callsB, IGNORED_QUEUES);

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

    await reconcilerA.reconcileWorkflowSchedules(now);
    expect(callsA.length).toBe(1);

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
    const first = new SchedulerReconciler({
      boss: createStubBoss(callsA, IGNORED_QUEUES),
      db: ctx.testDb.db,
    });
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
        boss: createStubBoss(calls, IGNORED_QUEUES),
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
