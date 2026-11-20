import { describe, expect, test } from "bun:test";
import {
  isTaskDue,
  nextTaskStart,
  smallestCronGapMs,
  TASK_SCHEDULE_MIN_INTERVAL_MS,
  type TaskScheduleFields,
  type TaskScheduleIssue,
  taskScheduleChanged,
  taskScheduleClock,
  taskScheduleIssue,
  taskTriggerFor,
} from "./schedule.ts";

const NOW = new Date("2026-11-19T08:00:00.000Z");
const MINUTE = 60_000;

function schedule(overrides: Partial<TaskScheduleFields> = {}): TaskScheduleFields {
  return { schedule_cron: null, schedule_timezone: null, schedule_run_at: null, ...overrides };
}

describe("taskScheduleIssue", () => {
  const valid: Array<[string, Partial<TaskScheduleFields>]> = [
    ["no schedule", {}],
    ["weekly cron", { schedule_cron: "0 8 * * 1" }],
    ["cron with timezone", { schedule_cron: "0 8 * * 1", schedule_timezone: "Europe/Berlin" }],
    ["every fifteen minutes", { schedule_cron: "*/15 * * * *" }],
    ["padded cron", { schedule_cron: "  0   8 * * 1 " }],
    ["one-time start", { schedule_run_at: "2026-12-01T08:00:00.000Z" }],
    ["one-time start in a millisecond", { schedule_run_at: "2026-11-19T08:00:00.001Z" }],
    [
      "one-time start with timezone",
      { schedule_run_at: "2026-12-01T08:00:00+01:00", schedule_timezone: "UTC" },
    ],
    ["timezone alone", { schedule_timezone: "America/New_York" }],
  ];
  for (const [label, fields] of valid)
    test(`accepts: ${label}`, () => {
      expect(taskScheduleIssue(schedule(fields), NOW)).toBeNull();
    });

  const invalid: Array<[string, Partial<TaskScheduleFields>, TaskScheduleIssue]> = [
    [
      "cron and one-time start",
      { schedule_cron: "0 8 * * 1", schedule_run_at: "2026-12-01T08:00:00.000Z" },
      "schedule_conflict",
    ],
    [
      "conflict before other problems",
      { schedule_cron: "every:5", schedule_run_at: "nope", schedule_timezone: "Mars/Olympus" },
      "schedule_conflict",
    ],
    [
      "unknown timezone",
      { schedule_cron: "0 8 * * 1", schedule_timezone: "Mars/Olympus" },
      "timezone_invalid",
    ],
    ["unknown timezone without cron", { schedule_timezone: "Mars/Olympus" }, "timezone_invalid"],
    [
      "timezone before an unreadable time",
      { schedule_run_at: "nope", schedule_timezone: "Mars/Olympus" },
      "timezone_invalid",
    ],
    ["unreadable time", { schedule_run_at: "next tuesday" }, "run_at_invalid"],
    ["one-time start right now", { schedule_run_at: "2026-11-19T08:00:00.000Z" }, "run_at_past"],
    ["one-time start in the past", { schedule_run_at: "2026-11-19T08:59:59+01:00" }, "run_at_past"],
    ["interval form", { schedule_cron: "every:3600" }, "cron_interval_form"],
    ["padded interval form", { schedule_cron: "  every:3600" }, "cron_interval_form"],
    ["six fields", { schedule_cron: "0 0 8 * * 1" }, "cron_invalid"],
    ["four fields", { schedule_cron: "0 8 * *" }, "cron_invalid"],
    ["not a cron", { schedule_cron: "a b c d e" }, "cron_invalid"],
    ["never fires", { schedule_cron: "0 0 31 2 *" }, "cron_invalid"],
    ["every minute", { schedule_cron: "* * * * *" }, "cron_too_frequent"],
    ["every ten minutes", { schedule_cron: "*/10 * * * *" }, "cron_too_frequent"],
    ["fourteen minutes apart", { schedule_cron: "0,14 * * * *" }, "cron_too_frequent"],
    ["close across midnight", { schedule_cron: "0,50 0,23 * * *" }, "cron_too_frequent"],
  ];
  for (const [label, fields, issue] of invalid)
    test(`rejects: ${label}`, () => {
      expect(taskScheduleIssue(schedule(fields), NOW)).toBe(issue);
    });
});

describe("smallestCronGapMs", () => {
  test("finds the smallest distance between two starts", () => {
    expect(TASK_SCHEDULE_MIN_INTERVAL_MS).toBe(15 * MINUTE);
    expect(smallestCronGapMs("*/15 * * * *", null, NOW)).toBe(15 * MINUTE);
    expect(smallestCronGapMs("0,20 * * * *", null, NOW)).toBe(20 * MINUTE);
    expect(smallestCronGapMs("0 8 * * *", "Europe/Berlin", NOW)).toBe(24 * 60 * MINUTE);
    expect(smallestCronGapMs("0 8 * * *", null, new Date("2025-11-29T00:00:00.000Z"))).toBe(
      24 * 60 * MINUTE,
    );
    expect(smallestCronGapMs("0 0 31 2 *", null, NOW)).toBeNull();
  });

  test("samples exactly 120 gaps", () => {
    const daily = "0 8 * * *";
    expect(smallestCronGapMs(daily, "Europe/Berlin", new Date("2025-11-29T00:00:00.000Z"))).toBe(
      23 * 60 * MINUTE,
    );
    expect(smallestCronGapMs(daily, "Europe/Berlin", new Date("2025-11-28T00:00:00.000Z"))).toBe(
      24 * 60 * MINUTE,
    );
  });

  test("looks far enough to see a rare close pair", () => {
    expect(smallestCronGapMs("0 0-23 * * 1-6,0", null, NOW)).toBe(60 * MINUTE);
    expect(smallestCronGapMs("0,10 0 19 3 *", null, NOW)).toBe(10 * MINUTE);
  });

  test("stops sampling where the calendar ends", () => {
    expect(smallestCronGapMs("* * * * *", null, new Date(8_639_999_996_400_000))).toBe(MINUTE);
  });
});

describe("nextTaskStart and isTaskDue", () => {
  const anchor = new Date("2026-11-16T09:00:00.000Z");

  test("without a schedule nothing is due", () => {
    expect(nextTaskStart(schedule(), { last_claimed_at: null, anchor })).toBeNull();
    expect(isTaskDue(schedule(), { last_claimed_at: null, anchor }, NOW)).toBe(false);
    expect(taskTriggerFor(schedule())).toBeNull();
  });

  test("a one-time start is due once at its time", () => {
    const once = schedule({ schedule_run_at: "2026-11-19T08:00:00.000Z" });
    expect(taskTriggerFor(once)).toBe("once");
    expect(nextTaskStart(once, { last_claimed_at: null, anchor })).toEqual(NOW);
    expect(isTaskDue(once, { last_claimed_at: null, anchor }, new Date(NOW.getTime() - 1))).toBe(
      false,
    );
    expect(isTaskDue(once, { last_claimed_at: null, anchor }, NOW)).toBe(true);
    expect(nextTaskStart(once, { last_claimed_at: NOW, anchor })).toBeNull();
    expect(
      isTaskDue(once, { last_claimed_at: NOW, anchor }, new Date(NOW.getTime() + MINUTE)),
    ).toBe(false);
  });

  test("a cron counts from the anchor until the first claim", () => {
    const daily = schedule({ schedule_cron: "0 8 * * *" });
    expect(taskTriggerFor(daily)).toBe("cron");
    expect(nextTaskStart(daily, { last_claimed_at: null, anchor })).toEqual(
      new Date("2026-11-17T08:00:00.000Z"),
    );
    expect(
      isTaskDue(daily, { last_claimed_at: null, anchor }, new Date("2026-11-17T07:59:59.000Z")),
    ).toBe(false);
    expect(
      isTaskDue(daily, { last_claimed_at: null, anchor }, new Date("2026-11-17T08:00:00.000Z")),
    ).toBe(true);
  });

  test("missed starts collapse into one after a claim", () => {
    const daily = schedule({ schedule_cron: "0 8 * * *" });
    expect(isTaskDue(daily, { last_claimed_at: null, anchor }, NOW)).toBe(true);
    const claimed = { last_claimed_at: NOW, anchor };
    expect(nextTaskStart(daily, claimed)).toEqual(new Date("2026-11-20T08:00:00.000Z"));
    expect(isTaskDue(daily, claimed, new Date("2026-11-19T23:00:00.000Z"))).toBe(false);
  });

  test("a cron without a timezone runs on UTC whatever zone the host is in", () => {
    const daily = schedule({ schedule_cron: "0 8 * * *" });
    const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(nextTaskStart(daily, { last_claimed_at: null, anchor })).toEqual(
        new Date("2026-11-17T08:00:00.000Z"),
      );
    } finally {
      process.env.TZ = host;
    }
  });

  test("a cron follows its timezone across the clock change", () => {
    const berlin = schedule({ schedule_cron: "0 8 * * *", schedule_timezone: "Europe/Berlin" });
    expect(
      nextTaskStart(berlin, {
        last_claimed_at: null,
        anchor: new Date("2026-03-28T12:00:00.000Z"),
      }),
    ).toEqual(new Date("2026-03-29T06:00:00.000Z"));
    expect(nextTaskStart(berlin, { last_claimed_at: null, anchor })).toEqual(
      new Date("2026-11-17T07:00:00.000Z"),
    );
  });
});

describe("taskScheduleChanged", () => {
  const base = schedule({ schedule_cron: "0 8 * * 1", schedule_timezone: "Europe/Berlin" });
  const once = schedule({ schedule_run_at: "2026-12-01T08:00:00.000Z" });

  test("ignores an unchanged schedule and another notation of the same instant", () => {
    expect(taskScheduleChanged(base, { ...base })).toBe(false);
    expect(taskScheduleChanged(schedule(), schedule())).toBe(false);
    expect(
      taskScheduleChanged(once, schedule({ schedule_run_at: "2026-12-01T09:00:00+01:00" })),
    ).toBe(false);
  });

  test("sees a change of cron, timezone or one-time start", () => {
    expect(taskScheduleChanged(base, { ...base, schedule_cron: "0 9 * * 1" })).toBe(true);
    expect(taskScheduleChanged(base, { ...base, schedule_timezone: null })).toBe(true);
    expect(
      taskScheduleChanged(once, schedule({ schedule_run_at: "2026-12-01T08:00:00.001Z" })),
    ).toBe(true);
    expect(taskScheduleChanged(once, schedule())).toBe(true);
    expect(taskScheduleChanged(schedule(), once)).toBe(true);
  });
});

describe("taskScheduleClock", () => {
  test("a stored hold anchors just before the start it still owes, otherwise the schedule anchor does", () => {
    const schedule_anchor_at = new Date("2026-11-19T08:00:00.000Z");
    const owed = new Date("2026-11-20T07:00:00.000Z");
    const claimed = new Date("2026-11-18T07:00:00.000Z");
    expect(
      taskScheduleClock({
        last_claimed_at: claimed,
        schedule_anchor_at,
        admission_hold_since: null,
      }),
    ).toEqual({ last_claimed_at: claimed, anchor: schedule_anchor_at });
    const clock = taskScheduleClock({
      last_claimed_at: null,
      schedule_anchor_at,
      admission_hold_since: owed,
    });
    expect(clock).toEqual({ last_claimed_at: null, anchor: new Date("2026-11-20T06:59:59.999Z") });
    const daily = { schedule_cron: "0 7 * * *", schedule_timezone: null, schedule_run_at: null };
    expect(nextTaskStart(daily, clock)).toEqual(owed);
  });
});
