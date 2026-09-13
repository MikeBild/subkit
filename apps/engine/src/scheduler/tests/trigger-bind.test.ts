// Reverse-bind helpers — `bindFromWorkflow` / `unbindFromWorkflow`
// for the schedule trigger variant.
//
// Schema-foundation portion of the schedule trigger. Executor logic
// for the schedule firing path lives in the reconciler; here we only
// verify the table is upserted idempotently and that delete emits the
// right audit signal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog, workflowsSchedules } from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { bindFromWorkflow, unbindFromWorkflow } from "../repo.ts";
import { createSchedulerCtx, type SchedulerTestCtx } from "./setup.ts";

let ctx: SchedulerTestCtx;
let workflowId: string;

beforeEach(async () => {
  ctx = await createSchedulerCtx("trigger-bind");
  const wf = await createWorkflowRow(ctx.engine, {
    name: "sched-bind",
    slug: "sched-bind",
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  workflowId = wf.workflow_id;
});

afterEach(async () => {
  await ctx.cleanup();
});

const triggerDaily = {
  kind: "schedule" as const,
  cron: "0 9 * * *",
  tz: "Europe/Berlin",
  business_days_only: true,
  skip_dates: ["2026-12-25"],
};

describe("scheduler trigger bind/unbind helpers", () => {
  test("bindFromWorkflow inserts a single schedule row, idempotent on repeat", async () => {
    const first = await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: triggerDaily,
      actor_id: null,
    });
    expect(first.status).toBe("created");
    expect(first.row.cron).toBe("0 9 * * *");
    expect(first.row.timezone).toBe("Europe/Berlin");
    expect(first.row.execution_mode).toBe("prod");

    const second = await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: triggerDaily,
      actor_id: null,
    });
    expect(second.status).toBe("noop");

    const allRows = await ctx.engine.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(
        and(
          eq(workflowsSchedules.tenant_id, ctx.engine.tenantId),
          eq(workflowsSchedules.workflow_id, workflowId),
        ),
      );
    expect(allRows.length).toBe(1);
    expect(allRows[0]?.input).toEqual({
      business_days_only: true,
      skip_dates: ["2026-12-25"],
    });
  });

  test("bindFromWorkflow rejects an invalid cron expression", async () => {
    await expect(
      bindFromWorkflow(ctx.engine.testDb.db, {
        tenant_id: ctx.engine.tenantId,
        workflow_id: workflowId,
        trigger: { kind: "schedule", cron: "not a cron", tz: "UTC" },
        actor_id: null,
      }),
    ).rejects.toThrow();
  });

  test("bindFromWorkflow updates timezone in place when changed", async () => {
    await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: triggerDaily,
      actor_id: null,
    });
    const updated = await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: { ...triggerDaily, tz: "America/New_York" },
      actor_id: null,
    });
    expect(updated.status).toBe("updated");
    expect(updated.row.timezone).toBe("America/New_York");
  });

  test("bindFromWorkflow preserves an explicit dev execution mode", async () => {
    const bound = await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: { ...triggerDaily, execution_mode: "dev" },
      actor_id: null,
    });
    expect(bound.row.execution_mode).toBe("dev");
  });

  test("bindFromWorkflow emits SCHEDULE_TRIGGER_BOUND audit row", async () => {
    await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: triggerDaily,
      actor_id: null,
    });
    const audits = await ctx.engine.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.engine.tenantId),
          eq(auditLog.action, "schedule.trigger.bound"),
        ),
      );
    expect(audits.length).toBe(1);
    expect(audits[0]?.resource_type).toBe("workflow_schedule");
  });

  test("unbindFromWorkflow removes the row + emits SCHEDULE_TRIGGER_UNBOUND", async () => {
    await bindFromWorkflow(ctx.engine.testDb.db, {
      tenant_id: ctx.engine.tenantId,
      workflow_id: workflowId,
      trigger: triggerDaily,
      actor_id: null,
    });
    const removed = await unbindFromWorkflow(
      ctx.engine.testDb.db,
      ctx.engine.tenantId,
      workflowId,
      null,
    );
    expect(removed).toBe(1);

    const remaining = await ctx.engine.testDb.db
      .select()
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.workflow_id, workflowId));
    expect(remaining.length).toBe(0);

    const audits = await ctx.engine.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.engine.tenantId),
          eq(auditLog.action, "schedule.trigger.unbound"),
        ),
      );
    expect(audits.length).toBe(1);
  });

  test("unbindFromWorkflow with no prior schedule returns 0", async () => {
    const removed = await unbindFromWorkflow(
      ctx.engine.testDb.db,
      ctx.engine.tenantId,
      workflowId,
      null,
    );
    expect(removed).toBe(0);
  });
});
