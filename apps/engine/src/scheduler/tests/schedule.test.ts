import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions, workflowsSchedules } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { parseCronExpression } from "../cron.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { grantScheduleAuthorityFixture } from "./authority-fixture.ts";
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
      steps: [{ id: "noop", kind: "transform", language: "javascript", expression: "input" }],
    });
    const authority = await grantScheduleAuthorityFixture(
      ctx.engine.testDb.db,
      ctx.engine.tenantId,
      workflow_id,
      "prod",
      1,
    );

    await ctx.engine.testDb.db.insert(workflowsSchedules).values({
      tenant_id: ctx.engine.tenantId,
      workflow_id,
      cron: "every:1",
      timezone: "UTC",
      paused: false,
      input: { from: "test" },
    });

    await registerExecutionRunHandler({ boss: ctx.boss, db: ctx.engine.testDb.db });

    const reconciler = new SchedulerReconciler({
      boss: ctx.boss,
      db: ctx.engine.testDb.db,
      intervalMs: 5_000,
    });
    await reconciler.start();

    try {
      // allow-wall-clock: this test exercises real-time polling or freshness windows.
      const deadline = Date.now() + 5_000;
      let rowCount = 0;
      let terminalExecutionMode: "dev" | "prod" | undefined;
      let terminalAuthority: string | null | undefined;
      let terminalStatus: string | undefined;
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
        if (terminal) {
          terminalExecutionMode = terminal.execution_mode;
          terminalAuthority = terminal.execution_authority_id;
          terminalStatus = terminal.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: cron-tick reconciler cadence
      }
      expect(rowCount).toBeGreaterThanOrEqual(1);
      expect(terminalExecutionMode).toBe("prod");
      expect(terminalAuthority).toBe(authority.id);
      expect(terminalStatus).toBe("succeeded");
    } finally {
      await reconciler.stop();
    }
  }, 20_000);

  test("a failed fire restores last_enqueued_at (the run is not lost)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx.engine, {
      name: "sched-compensate",
      slug: "sched-compensate",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await grantScheduleAuthorityFixture(ctx.engine.testDb.db, ctx.engine.tenantId, workflow_id);
    const [sched] = await ctx.engine.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.engine.tenantId,
        workflow_id,
        cron: "* * * * *",
        timezone: "UTC",
        paused: false,
        input: { from: "test" },
        created_at: new Date(getTestNow() - 120_000),
      })
      .returning();

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

    const [after] = await ctx.engine.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, sched!.id));
    expect(after?.last_enqueued_at).toBeNull();
  }, 20_000);

  test("an outdated schedule input is held before it is enqueued", async () => {
    const { workflow_id } = await createWorkflowRow(ctx.engine, {
      name: "sched-input-hold",
      slug: "sched-input-hold",
      input_schema: {
        type: "object",
        required: ["account_id"],
        properties: { account_id: { type: "string" } },
      },
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    const [schedule] = await ctx.engine.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.engine.tenantId,
        workflow_id,
        cron: "* * * * *",
        timezone: "UTC",
        paused: false,
        input: {},
        created_at: new Date(getTestNow() - 120_000),
      })
      .returning();
    const reconciler = new SchedulerReconciler({
      boss: ctx.boss,
      db: ctx.engine.testDb.db,
      intervalMs: 60_000,
    });
    await reconciler.reconcileWorkflowSchedules(new Date(getTestNow()));
    const [after] = await ctx.engine.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, schedule!.id));
    expect(after?.last_enqueued_at).toBeNull();
    expect(after?.admission_hold?.reason_code).toBe("input_required");
    expect(after?.input_error?.issues[0]?.path).toBe("$input/account_id");
  }, 20_000);

  test("a fresh cron schedule waits for its first occurrence after creation", async () => {
    const db = ctx.engine.testDb.db;
    const { workflow_id } = await createWorkflowRow(ctx.engine, {
      name: "sched-fresh",
      slug: "sched-fresh",
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await grantScheduleAuthorityFixture(db, ctx.engine.tenantId, workflow_id);
    const createdAt = new Date("2026-07-04T04:57:00Z");
    const [sched] = await db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.engine.tenantId,
        workflow_id,
        cron: "0 7 * * *",
        timezone: "Europe/Berlin",
        paused: false,
        input: null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning();

    const reconciler = new SchedulerReconciler({
      boss: ctx.boss,
      db,
      intervalMs: 60_000,
    });

    await reconciler.reconcileWorkflowSchedules(new Date("2026-07-04T04:59:00Z"));
    let [row] = await db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, sched!.id));
    expect(row?.last_enqueued_at).toBeNull();

    await reconciler.reconcileWorkflowSchedules(new Date("2026-07-04T05:00:30Z"));
    [row] = await db.select().from(workflowsSchedules).where(eq(workflowsSchedules.id, sched!.id));
    expect(row?.last_enqueued_at).not.toBeNull();
  }, 20_000);
});
