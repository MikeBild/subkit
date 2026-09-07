// Schedule trigger calendar-gate executor.
//
// Walks the workflow-schedule fan-out through one fire window plus a
// weekend plus a skip-date and asserts:
//   - exactly ONE execution row is created over the four firings
//   - `last_enqueued_at` is bumped only on the firing pass
//   - the audit log carries the `schedule.trigger.fired` row with the
//     execution id stitched in
//   - the calendar-gate keys never leak into the workflow's `input`
//     payload
//
// Uses a stubbed pg-boss to keep the test deterministic. The
// reconciler's enqueue path goes through `boss.send`, which we record;
// the execution.run worker is NOT registered here because the contract
// being verified is the scheduler's enqueue dedup + calendar gating —
// the worker behaviour is covered by `schedule.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog, executions, workflowsSchedules } from "../../db/schema/index.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { calendarGateSkipReason, localDateInTz, SchedulerReconciler } from "../reconciler.ts";
import { grantScheduleAuthorityFixture } from "./authority-fixture.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("sched-calendar");
});

afterAll(async () => {
  await ctx.cleanup();
});

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

describe("calendar gate helpers", () => {
  test("localDateInTz formats Berlin midnight", () => {
    // 2026-03-13 00:30 in Berlin (CET, UTC+1) is 2026-03-12 23:30 UTC.
    // The local-tz date in Berlin is "2026-03-13", in UTC it would be
    // "2026-03-12". The skip-date comparison must use the local date.
    const utc = new Date(Date.UTC(2026, 2, 12, 23, 30, 0));
    expect(localDateInTz(utc, "Europe/Berlin")).toBe("2026-03-13");
    expect(localDateInTz(utc, "UTC")).toBe("2026-03-12");
  });

  test("calendarGateSkipReason returns weekend on Saturday in tz", () => {
    // 2026-05-02 is a Saturday in Berlin.
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
      steps: [{ id: "noop", kind: "transform", expression: "$input" }],
    });
    await grantScheduleAuthorityFixture(ctx.testDb.db, ctx.tenantId, workflow_id);

    // The schedule is identical to what `bindFromWorkflow` would have
    // produced for a `trigger: { kind: "schedule", cron: "0 9 * * *",
    // tz: "Europe/Berlin", business_days_only: true,
    // skip_dates: ["2026-12-25"] }` block — calendar gates ride
    // inside the `input` jsonb.
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
        // Seed `last_enqueued_at` 25h before the first tick so the
        // dedup gate is open and we exercise the calendar gate alone.
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

    // Tick 1 — Friday 2026-05-15 09:00 Berlin = 07:00 UTC.
    // Business day, not in skip_dates → fires.
    const friday = new Date(Date.UTC(2026, 4, 15, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(friday);

    // Tick 2 — Saturday 2026-05-16 09:00 Berlin = 07:00 UTC.
    // Weekend → must skip without bumping `last_enqueued_at`.
    const saturday = new Date(Date.UTC(2026, 4, 16, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(saturday);

    // Tick 3 — Sunday 2026-05-17 09:00 Berlin = 07:00 UTC.
    // Weekend → must also skip.
    const sunday = new Date(Date.UTC(2026, 4, 17, 7, 0, 0));
    await reconciler.reconcileWorkflowSchedules(sunday);

    // Tick 4 — fast-forward to 2026-12-25 09:00 Berlin = 08:00 UTC
    // (winter, CET = UTC+1). Christmas is a Friday in 2026 — business
    // day, but explicitly in `skip_dates`. Must skip.
    const xmas = new Date(Date.UTC(2026, 11, 25, 8, 0, 0));
    await reconciler.reconcileWorkflowSchedules(xmas);

    // Only the Friday firing should have produced an execution row +
    // a `boss.send` call.
    const callsForWorkflow = calls.filter(
      (c) => (c.payload as { workflow_id?: string })?.workflow_id === workflow_id,
    );
    expect(callsForWorkflow.length).toBe(1);

    // The payload that goes to the worker must NOT carry the
    // calendar-gate keys — they are scheduler-internal.
    const payload = callsForWorkflow[0]?.payload as { input: unknown };
    expect(payload.input).toBeNull();

    // `last_enqueued_at` was bumped to the Friday tick and was NOT
    // pushed forward by the weekend or skip-date passes (otherwise a
    // recovery firing would be silently lost).
    const refreshed = (
      await ctx.testDb.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, scheduleId))
    )[0];
    expect(refreshed?.last_enqueued_at?.getTime()).toBe(friday.getTime());

    // Exactly one execution row, in the queued state.
    const execRows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.workflow_id, workflow_id));
    expect(execRows.length).toBe(1);
    expect(execRows[0]?.request_source).toBe("scheduler");

    // The fire emitted `schedule.trigger.fired` keyed on the schedule
    // row, with the execution id stitched into metadata — so a SOC2
    // auditor can answer "what woke this workflow at 09:00 Berlin".
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
