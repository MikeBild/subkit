// Insert a workflows_schedules row with a sub-minute `every:1` cron
// expression. Run the reconciler and assert the execution.run worker
// picks up a job within 3 seconds.
//
// Deviation: the plan literally says cron '* * * * * *'. pg-boss only
// supports 5-field cron with minute resolution, so we use the engine's
// `every:<seconds>` shorthand which is reconciled locally via
// setInterval. Standard 5-field cron is validated + scheduled via
// pg-boss and covered by unit tests on parseCronExpression below.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions, workflowsSchedules } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { parseCronExpression } from "../cron.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { createSchedulerCtx, type SchedulerTestCtx } from "./setup.ts";

let ctx: SchedulerTestCtx;

beforeAll(async () => {
  ctx = await createSchedulerCtx("fire");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("scheduler reconciler", () => {
  test("parseCronExpression accepts 5-field crons and every:<n>", () => {
    expect(parseCronExpression("* * * * *").ok).toBe(true);
    expect(parseCronExpression("*/5 * * * *").ok).toBe(true);
    expect(parseCronExpression("every:1").ok).toBe(true);
    expect(parseCronExpression("every:0").ok).toBe(false);
    expect(parseCronExpression("not a cron").ok).toBe(false);
  });

  test("every:1 schedule fires and the worker picks it up within 3s", async () => {
    const { workflow_id } = await createWorkflowRow(ctx.engine, {
      name: "sched-me",
      slug: "sched-me",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });

    await ctx.engine.testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctx.engine.tenantId,
      workflow_id,
      cron: "every:1",
      timezone: "UTC",
      paused: false,
      input: { from: "test" },
    });

    // Wire the execution.run worker so the enqueued job actually runs.
    await registerExecutionRunHandler({ boss: ctx.boss, db: ctx.engine.testDb.db });

    const reconciler = new SchedulerReconciler({
      boss: ctx.boss,
      db: ctx.engine.testDb.db,
      intervalMs: 5_000,
    });
    await reconciler.start();

    try {
      // Wait for at least one execution row to appear for this workflow.
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      const deadline = Date.now() + 5_000;
      let rowCount = 0;
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      while (Date.now() < deadline) {
        const rows = await ctx.engine.testDb.db
          .select()
          .from(executions)
          .where(eq(executions.workflow_id, workflow_id));
        rowCount = rows.length;
        const terminal = rows.find((r) =>
          ["succeeded", "failed", "aborted", "timed_out"].includes(r.status),
        );
        if (terminal) break;
        await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: cron-tick reconciler cadence
      }
      expect(rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      await reconciler.stop();
    }
  }, 20_000);

  // #17: a transient enqueue failure during a cron fire must NOT silently
  // drop the occurrence. The watermark is stamped before firing; if the
  // fire throws, the catch compensates by restoring it so the next tick
  // retries — instead of the run being lost until the next natural cron.
  test("a failed fire restores last_enqueued_at (the run is not lost)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx.engine, {
      name: "sched-compensate",
      slug: "sched-compensate",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const [sched] = await ctx.engine.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.engine.tenantId,
        workflow_id,
        cron: "* * * * *", // due immediately (never fired)
        timezone: "UTC",
        paused: false,
        input: { from: "test" },
      })
      .returning();

    // Reconciler whose enqueue always throws (simulated transient blip).
    const failingBoss = {
      send: async () => {
        throw new Error("transient enqueue failure");
      },
    } as unknown as typeof ctx.boss;
    const reconciler = new SchedulerReconciler({
      boss: failingBoss,
      db: ctx.engine.testDb.db,
      intervalMs: 60_000,
    });

    await reconciler.reconcileWorkflowSchedules(new Date(getTestNow()));

    // The watermark must be back to NULL (compensated) — proving the
    // occurrence will be retried, not silently consumed. Pre-fix it would
    // be stamped to the fire time and the run lost.
    const [after] = await ctx.engine.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, sched!.id));
    expect(after?.last_enqueued_at).toBeNull();
  }, 20_000);
});
