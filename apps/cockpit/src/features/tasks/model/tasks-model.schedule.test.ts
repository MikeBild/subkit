import { describe, expect, test } from "bun:test";
import { task } from "./tasks-fixtures";
import {
  cronToOption,
  instantToLocalInput,
  localInputToInstant,
  nextStart,
  optionToCron,
  rhythm,
  SCHEDULE_OPTIONS,
  type ScheduleDraft,
  scheduleDraft,
  scheduleFields,
  withCurrent,
  zonedInstant,
} from "./tasks-model";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const BERLIN = "Europe/Berlin";

const draft = (change: Partial<ScheduleDraft>): ScheduleDraft => ({
  option: "manual",
  time: "07:00",
  weekday: 1,
  runAt: "",
  cron: "",
  timezone: BERLIN,
  ...change,
});

describe("schedule choices", () => {
  test("every choice maps to its cron expression and back", () => {
    expect(optionToCron(draft({ option: "daily", time: "07:00" }))).toBe("0 7 * * *");
    expect(optionToCron(draft({ option: "weekdays", time: "08:30" }))).toBe("30 8 * * 1-5");
    expect(optionToCron(draft({ option: "weekly", time: "09:05", weekday: 3 }))).toBe("5 9 * * 3");
    expect(optionToCron(draft({ option: "weekly", time: "09:05", weekday: 7 }))).toBe("5 9 * * 0");
    expect(optionToCron(draft({ option: "custom", cron: " */30 * * * * " }))).toBe("*/30 * * * *");
    expect(optionToCron(draft({ option: "custom", cron: " " }))).toBeNull();
    expect(optionToCron(draft({ option: "daily", time: "7" }))).toBeNull();
    expect(optionToCron(draft({ option: "manual" }))).toBeNull();
    expect(optionToCron(draft({ option: "once" }))).toBeNull();

    expect(cronToOption("0 7 * * *")).toEqual({ option: "daily", time: "07:00", weekday: 1 });
    expect(cronToOption("30 8 * * 1-5")).toEqual({
      option: "weekdays",
      time: "08:30",
      weekday: 1,
    });
    expect(cronToOption("5 9 * * 7")).toEqual({ option: "weekly", time: "09:05", weekday: 0 });
    for (const custom of [
      "*/30 * * * *",
      "0 7 1 * *",
      "0 7 * 2 *",
      "0 7 * * 1,3",
      "61 7 * * *",
      "0 25 * * *",
      "x",
    ])
      expect(cronToOption(custom)).toBeNull();
  });

  test("a stored schedule opens as the choice a person made", () => {
    const options = SCHEDULE_OPTIONS.map((option) => option);
    expect(options).toEqual(["manual", "once", "daily", "weekdays", "weekly", "custom"]);
    expect(scheduleDraft(null, BERLIN)).toMatchObject({ option: "manual", timezone: BERLIN });
    expect(
      scheduleDraft(
        { schedule_cron: "0 7 * * *", schedule_timezone: "UTC", schedule_run_at: null },
        BERLIN,
      ),
    ).toMatchObject({ option: "daily", time: "07:00", timezone: "UTC" });
    expect(
      scheduleDraft(
        { schedule_cron: "0 7 * * 1-5", schedule_timezone: null, schedule_run_at: null },
        BERLIN,
      ).option,
    ).toBe("weekdays");
    expect(
      scheduleDraft(
        { schedule_cron: "0 7 * * 2", schedule_timezone: "Not/AZone", schedule_run_at: null },
        BERLIN,
      ),
    ).toMatchObject({ option: "weekly", weekday: 2, timezone: BERLIN });
    expect(
      scheduleDraft(
        { schedule_cron: "*/30 * * * *", schedule_timezone: BERLIN, schedule_run_at: null },
        BERLIN,
      ),
    ).toMatchObject({ option: "custom", cron: "*/30 * * * *" });
    expect(
      scheduleDraft(
        { schedule_cron: null, schedule_timezone: BERLIN, schedule_run_at: "2026-12-01T07:00:00Z" },
        BERLIN,
      ),
    ).toMatchObject({ option: "once", runAt: "2026-12-01T08:00" });
  });

  test("the saved fields follow the choice and name the first thing to fix", () => {
    expect(scheduleFields(draft({ option: "manual" }), NOW)).toEqual({
      ok: true,
      fields: { schedule_cron: null, schedule_timezone: null, schedule_run_at: null },
    });
    expect(scheduleFields(draft({ option: "daily" }), NOW)).toEqual({
      ok: true,
      fields: { schedule_cron: "0 7 * * *", schedule_timezone: BERLIN, schedule_run_at: null },
    });
    expect(scheduleFields(draft({ option: "once", runAt: "2026-12-01T08:00" }), NOW)).toEqual({
      ok: true,
      fields: {
        schedule_cron: null,
        schedule_timezone: BERLIN,
        schedule_run_at: "2026-12-01T07:00:00.000Z",
      },
    });
    const issue = (change: Partial<ScheduleDraft>) => {
      const result = scheduleFields(draft(change), NOW);
      return result.ok ? null : result.issue;
    };
    expect(issue({ option: "once", runAt: "" })).toBe("tasks.schedule.error.runAt");
    expect(issue({ option: "once", runAt: "2026-11-19T10:59" })).toBe(
      "tasks.schedule.error.runAtPast",
    );
    expect(issue({ option: "weekly", time: "" })).toBe("tasks.schedule.error.time");
    expect(issue({ option: "custom", cron: "" })).toBe("tasks.schedule.error.cron");
    expect(issue({ option: "custom", cron: "0 7 * *" })).toBe("tasks.schedule.error.cron");
    expect(issue({ option: "custom", cron: "0 7 * * 1" })).toBeNull();
  });

  test("local times convert through the chosen time zone, across daylight saving", () => {
    expect(localInputToInstant("2026-07-01T08:00", BERLIN)).toBe("2026-07-01T06:00:00.000Z");
    expect(localInputToInstant("2026-12-01T08:00", BERLIN)).toBe("2026-12-01T07:00:00.000Z");
    expect(localInputToInstant("2026-12-01T08:00", "UTC")).toBe("2026-12-01T08:00:00.000Z");
    expect(localInputToInstant("tomorrow", BERLIN)).toBeNull();
    expect(instantToLocalInput("2026-07-01T06:00:00Z", BERLIN)).toBe("2026-07-01T08:00");
    expect(instantToLocalInput("nonsense", BERLIN)).toBe("");
    expect(
      zonedInstant({ year: 2026, month: 3, day: 29, hour: 9, minute: 0 }, BERLIN).toISOString(),
    ).toBe("2026-03-29T07:00:00.000Z");
  });

  test("a local time skipped by the spring clock change is rejected, not moved", () => {
    const issue = (runAt: string) => {
      const result = scheduleFields(draft({ option: "once", runAt }), NOW);
      return result.ok ? result.fields.schedule_run_at : result.issue;
    };
    expect(localInputToInstant("2027-03-28T02:30", BERLIN)).toBeNull();
    expect(issue("2027-03-28T02:30")).toBe("tasks.schedule.error.runAtGap");
    expect(issue("2027-03-28T03:30")).toBe("2027-03-28T01:30:00.000Z");
    expect(issue("2027-03-28T01:59")).toBe("2027-03-28T00:59:00.000Z");
    expect(issue("2027-10-31T02:30")).toMatch(/^2027-10-31T0[01]:30:00\.000Z$/);
    expect(issue("2027-03-28T02:30")).not.toBe("tasks.schedule.error.runAt");
  });

  test("the next start is computed for every choice a person can make", () => {
    const next = (cron: string | null, zone: string | null = BERLIN, at = NOW) =>
      nextStart(
        { schedule_cron: cron, schedule_timezone: zone, schedule_run_at: null },
        at,
      )?.toISOString() ?? null;
    expect(next("0 7 * * *")).toBe("2026-11-20T06:00:00.000Z");
    expect(next("0 12 * * *")).toBe("2026-11-19T11:00:00.000Z");
    expect(next("0 7 * * 1-5", BERLIN, Date.parse("2026-11-20T10:00:00Z"))).toBe(
      "2026-11-23T06:00:00.000Z",
    );
    expect(next("0 8 * * 1")).toBe("2026-11-23T07:00:00.000Z");
    expect(next("0 7 * * *", null)).toBe("2026-11-20T07:00:00.000Z");
    expect(next("*/30 * * * *")).toBeNull();
    expect(next("0 7 * * *", "Not/AZone")).toBeNull();
    expect(next(null)).toBeNull();
    const once = { schedule_cron: null, schedule_timezone: BERLIN };
    expect(
      nextStart({ ...once, schedule_run_at: "2026-12-01T07:00:00Z" }, NOW)?.toISOString(),
    ).toBe("2026-12-01T07:00:00.000Z");
    expect(
      nextStart(
        {
          ...once,
          schedule_run_at: "2026-11-01T07:00:00Z",
          last_claimed_at: "2026-11-01T07:00:01Z",
        },
        NOW,
      ),
    ).toBeNull();
    expect(nextStart({ ...once, schedule_run_at: "nonsense" }, NOW)).toBeNull();
  });

  test("the rhythm of a task reads as one of four kinds", () => {
    expect(rhythm(task())).toEqual({ kind: "manual" });
    expect(rhythm(task({ schedule_cron: "0 7 * * *" }))).toEqual({
      kind: "cron",
      cron: "0 7 * * *",
    });
    expect(rhythm(task({ schedule_run_at: "2026-12-01T07:00:00Z" }))).toEqual({
      kind: "once",
      at: "2026-12-01T07:00:00Z",
    });
    expect(
      rhythm(
        task({ schedule_run_at: "2026-11-01T07:00:00Z", last_claimed_at: "2026-11-01T07:00:01Z" }),
      ),
    ).toEqual({ kind: "done" });
  });

  test("limit choices keep a value that was set elsewhere", () => {
    expect(withCurrent([10, 20, 50], 20)).toEqual([10, 20, 50]);
    expect(withCurrent([10, 20, 50], 35)).toEqual([10, 20, 35, 50]);
  });
});
