import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executions, workflowsSchedules } from "../../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { calendarGateSkipReason, localDateInTz } from "../calendar-gates.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { grantScheduleAuthorityFixture } from "./authority-fixture.ts";
import { createStubBoss, type SendCall } from "./stub-boss.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-calendar");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("calendar gate helpers", () => {
  test("localDateInTz formats Berlin midnight", () => {
    const utc = new Date(Date.UTC(2026, 2, 12, 23, 30, 0));
    expect(localDateInTz(utc, "Europe/Berlin")).toBe("2026-03-13");
    expect(localDateInTz(utc, "UTC")).toBe("2026-03-12");
  });

  test("calendarGateSkipReason returns weekend on Saturday in tz", () => {
    const sat = new Date("2026-05-02T08:00:00Z");
    expect(calendarGateSkipReason(sat, "Europe/Berlin", { business_days_only: true })).toBe(
      "weekend",
    );
    expect(calendarGateSkipReason(sat, "Europe/Berlin", { business_days_only: false })).toBeNull();
  });

  test("calendarGateSkipReason returns skip_date when local date matches", () => {
    const dec25 = new Date(Date.UTC(2026, 11, 25, 8, 0, 0));
    expect(calendarGateSkipReason(dec25, "Europe/Berlin", { skip_dates: ["2026-12-25"] })).toBe(
      "skip_date",
    );
    expect(
      calendarGateSkipReason(dec25, "Europe/Berlin", { skip_dates: ["2026-01-01"] }),
    ).toBeNull();
  });
});

describe("scheduler reconciler honours tz + business_days_only + skip_dates", () => {
  test("daily 09:00 Berlin schedule fires once across fire + weekend + skip-date", async () => {
    const calls: SendCall[] = [];
    const boss = createStubBoss(calls);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "stripe-daily-charges-digest",
      slug: "stripe-daily-charges-digest",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);

    const [scheduleRow] = await ctx.testDb.db
      .insert(workflowsSchedules)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id,
        cron: "0 9 * * *",
        timezone: "Europe/Berlin",
        paused: false,
        input: {
          business_days_only: true,
          skip_dates: ["2026-12-25"],
        },
        last_enqueued_at: new Date(Date.UTC(2026, 4, 14, 7, 0, 0)),
      })
      .returning();
    if (!scheduleRow) throw new Error("schedule insert failed");
    const scheduleId = scheduleRow.id;

    const reconciler = new SchedulerReconciler({
      boss,
      db: ctx.testDb.db,
      intervalMs: 60_000,
    });

    const friday = new Date(Date.UTC(2026, 4, 15, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(friday);

    const saturday = new Date(Date.UTC(2026, 4, 16, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(saturday);

    const sunday = new Date(Date.UTC(2026, 4, 17, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(sunday);

    const xmas = new Date(Date.UTC(2026, 11, 25, 8, 0, 0));
    await reconciler.reconcileWorkflowSchedules(xmas);

    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(1);

    expect(callsForWorkflow[0]?.payload).not.toHaveProperty("input");

    const refreshed = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    expect(refreshed?.last_enqueued_at?.getTime()).toBe(friday.getTime());

    const execRows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, workflow_id));
    expect(execRows.length).toBe(1);
    expect(execRows[0]?.request_source).toBe("scheduler");
    expect(execRows[0]?.input).toEqual({});
    expect(execRows[0]?.caller_context).toBeNull();

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "schedule.trigger.fired")),
      );
    expect(audits.length).toBe(1);
    expect(audits[0]?.resource_id).toBe(scheduleId);
    const md = audits[0]?.metadata as Record<string, unknown> | null;
    expect(md?.workflow_id).toBe(workflow_id);
    expect(md?.tz).toBe("Europe/Berlin");
    expect(md?.execution_id).toBe(execRows[0]?.id);
  });
});
