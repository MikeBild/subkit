import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  executions,
  scheduleOccurrences,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { calendarGateSkipReason, localDateInTz } from "../calendar-gates.ts";
import { SchedulerReconciler } from "../reconciler.ts";
import { fireEverySchedule } from "../workflow-schedule-sweep.ts";
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

const lateSweep = async (
  slug: string,
  input: Record<string, unknown>,
  lastEnqueuedAt: Date,
  sweepAt: Date,
) => {
  const calls: SendCall[] = [];
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
  await ctx.testDb.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenantId,
    workflow_id,
    cron: "59 23 * * *",
    timezone: "America/Phoenix",
    paused: false,
    input,
    last_enqueued_at: lastEnqueuedAt,
  });
  const reconciler = new SchedulerReconciler({
    boss: createStubBoss(calls),
    db: ctx.testDb.db,
    intervalMs: 60_000,
  });
  await reconciler.reconcileWorkflowSchedules(sweepAt);
  const sends = calls.filter(
    (call) => (call.payload as { workflow_id?: string })?.workflow_id === workflow_id,
  );
  const execRows = await ctx.testDb.db
    .select()
    .from(executions)
    .where(eq(executions.workflow_id, workflow_id));
  const occurrences = await ctx.testDb.db
    .select()
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.workflow_id, workflow_id));
  return { sends, execRows, occurrences };
};

describe("calendar gate judges the due occurrence, not the late sweep", () => {
  const previousDue = new Date("2026-11-23T06:59:00Z");
  const sweepAfterLocalMidnight = new Date("2026-11-24T07:00:09Z");

  test("an excluded 23:59 occurrence swept after local midnight is skipped", async () => {
    const { sends, execRows, occurrences } = await lateSweep(
      "late-sweep-skip-date",
      { skip_dates: ["2026-11-23"] },
      previousDue,
      sweepAfterLocalMidnight,
    );
    expect(sends.length).toBe(0);
    expect(execRows.length).toBe(0);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0]?.state).toBe("skipped");
    expect(occurrences[0]?.reason_code).toBe("calendar_skip_date");
    expect(occurrences[0]?.last_due_at.toISOString()).toBe("2026-11-24T06:59:00.000Z");
  });

  test("the same late sweep fires when the day is not excluded", async () => {
    const { sends, execRows } = await lateSweep(
      "late-sweep-control",
      {},
      previousDue,
      sweepAfterLocalMidnight,
    );
    expect(sends.length).toBe(1);
    expect(execRows.length).toBe(1);
  });

  test("a Friday 23:59 business-day occurrence swept on Saturday still fires", async () => {
    const { sends, occurrences } = await lateSweep(
      "late-sweep-business-day",
      { business_days_only: true },
      new Date("2026-11-20T06:59:00Z"),
      new Date("2026-11-21T07:00:09Z"),
    );
    expect(sends.length).toBe(1);
    expect(occurrences[0]?.state).toBe("ran");
  });
});

const intervalTicks = async (slug: string, input: Record<string, unknown>, ticks: Date[]) => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    steps: [{ id: "noop", kind: "transform", expression: "$input" }],
  });
  await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);
  const [schedule] = await ctx.testDb.db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id,
      cron: "every:15",
      timezone: "Asia/Kathmandu",
      paused: false,
      input,
      last_enqueued_at: null,
      created_at: new Date("2026-11-01T00:00:00Z"),
    })
    .returning();
  if (!schedule) throw new Error("schedule insert failed");
  const fired: string[] = [];
  const definition = {
    schedule_id: schedule.id,
    tenant_id: ctx.tenantId,
    workflow_id,
    seconds: 15,
  };
  const tick = (at: Date) =>
    fireEverySchedule(
      ctx.testDb.db,
      definition,
      async (key) => {
        fired.push(key);
      },
      at,
    );
  for (const at of ticks) await tick(at);
  const occurrences = () =>
    ctx.testDb.db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.workflow_id, workflow_id));
  return { schedule, fired, tick, occurrences };
};

const ticksFrom = (start: string, count: number) =>
  Array.from({ length: count }, (_, index) => new Date(Date.parse(start) + index * 15_000));

describe("interval schedules honour the calendar gate", () => {
  test("an every:15 schedule does not run on an excluded local date and runs once it is removed", async () => {
    const { schedule, fired, tick, occurrences } = await intervalTicks(
      "interval-skip-date",
      { skip_dates: ["2026-11-24"] },
      ticksFrom("2026-11-24T02:00:00Z", 4),
    );
    expect(fired).toHaveLength(0);
    const skipped = await occurrences();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.state).toBe("skipped");
    expect(skipped[0]?.reason_code).toBe("calendar_skip_date");
    expect(skipped[0]?.skipped_count).toBeGreaterThan(1);
    await ctx.testDb.db
      .update(workflowsSchedules)
      .set({ input: {}, updated_at: new Date("2026-11-24T02:00:50Z") })
      .where(eq(workflowsSchedules.id, schedule.id));
    await tick(new Date("2026-11-24T02:01:00Z"));
    expect(fired).toHaveLength(1);
    const after = await occurrences();
    expect(after).toHaveLength(1);
    expect(after.some((entry) => entry.state === "ran")).toBe(false);
  });

  test("an every:15 business-day schedule does not run on a local weekend", async () => {
    const { fired, occurrences } = await intervalTicks(
      "interval-weekend",
      { business_days_only: true },
      ticksFrom("2026-11-28T06:00:00Z", 3),
    );
    expect(fired).toHaveLength(0);
    const skipped = await occurrences();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason_code).toBe("calendar_weekend");
  });

  test("an every:15 business-day schedule runs on a local weekday", async () => {
    const { fired } = await intervalTicks(
      "interval-weekday",
      { business_days_only: true },
      ticksFrom("2026-11-27T06:00:00Z", 1),
    );
    expect(fired).toHaveLength(1);
  });
});
