import { describe, expect, test } from "bun:test";
import { needsApproval } from "../operator/core/attention.ts";
import {
  decidePush,
  isCriticalPush,
  isoWeekday,
  lastOccurrence,
  localDateTime,
  nextOccurrence,
  nextWorkingStart,
  safeTimeZone,
  withinWorkingHours,
  workingDays,
  zonedInstant,
} from "./quiet-hours.ts";

const BERLIN = "Europe/Berlin";
const at = (iso: string) => new Date(iso);
const iso = (date: Date) => date.toISOString();

describe("local time of a person", () => {
  test("an instant is read in the person's zone, an unknown zone falls back to UTC", () => {
    expect(localDateTime(at("2026-11-20T08:30:00Z"), BERLIN)).toEqual({
      year: 2026,
      month: 11,
      day: 20,
      hour: 9,
      minute: 30,
    });
    expect(localDateTime(at("2026-07-01T22:30:00Z"), BERLIN)).toMatchObject({ day: 2, hour: 0 });
    expect(localDateTime(at("2026-11-20T08:30:00Z"), "America/New_York")).toMatchObject({
      hour: 3,
    });
    expect(safeTimeZone("Mars/Olympus")).toBe("UTC");
    expect(localDateTime(at("2026-11-20T08:30:00Z"), "Mars/Olympus")).toMatchObject({ hour: 8 });
  });

  test("a wall-clock time becomes the right instant in winter and summer", () => {
    expect(iso(zonedInstant({ year: 2026, month: 11, day: 20 }, 9 * 60, BERLIN))).toBe(
      "2026-11-20T08:00:00.000Z",
    );
    expect(iso(zonedInstant({ year: 2026, month: 7, day: 1 }, 9 * 60, BERLIN))).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(iso(zonedInstant({ year: 2026, month: 7, day: 1 }, 0, "Asia/Kolkata"))).toBe(
      "2026-06-30T18:30:00.000Z",
    );
  });

  test("a time skipped by the spring change moves forward by the gap", () => {
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 2 * 60 + 30, BERLIN))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(localDateTime(at("2026-03-29T01:30:00Z"), BERLIN)).toMatchObject({
      hour: 3,
      minute: 30,
    });
    expect(iso(zonedInstant({ year: 2026, month: 3, day: 29 }, 9 * 60, BERLIN))).toBe(
      "2026-03-29T07:00:00.000Z",
    );
  });

  test("a time repeated by the autumn change means its first occurrence", () => {
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25 }, 2 * 60 + 30, BERLIN))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(iso(zonedInstant({ year: 2026, month: 10, day: 25 }, 9 * 60, BERLIN))).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });
});

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

describe("working hours", () => {
  test("the window includes its start and excludes its end", () => {
    const inside = (time: string) =>
      withinWorkingHours({ from: "09:00", to: "17:00" }, at(`2026-11-20T${time}:00Z`), BERLIN);
    expect(inside("07:59")).toBe(false);
    expect(inside("08:00")).toBe(true);
    expect(inside("15:59")).toBe(true);
    expect(inside("16:00")).toBe(false);
    expect(inside("23:30")).toBe(false);
  });

  test("a window across midnight and a window that spans the whole day", () => {
    const night = (time: string) =>
      withinWorkingHours(
        { from: "22:00", to: "06:00", days: EVERY_DAY },
        at(`2026-11-20T${time}:00Z`),
        "UTC",
      );
    expect(night("21:59")).toBe(false);
    expect(night("22:00")).toBe(true);
    expect(night("03:00")).toBe(true);
    expect(night("06:00")).toBe(false);
    expect(
      withinWorkingHours({ from: "09:00", to: "09:00" }, at("2026-11-20T03:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      withinWorkingHours({ from: "09:00", to: "09:00" }, at("2026-11-21T12:00:00Z"), "UTC"),
    ).toBe(false);
  });

  test("working days are Monday to Friday unless the person chose others", () => {
    expect(isoWeekday({ year: 2026, month: 11, day: 20 })).toBe(5);
    expect(isoWeekday({ year: 2026, month: 11, day: 22 })).toBe(7);
    expect([...workingDays(undefined)]).toEqual([1, 2, 3, 4, 5]);
    expect([...workingDays([6, 7])]).toEqual([6, 7]);
    expect([...workingDays([])]).toEqual([1, 2, 3, 4, 5]);
    expect([...workingDays([0, 8, 2.5])]).toEqual([1, 2, 3, 4, 5]);
    const office = { from: "09:00", to: "17:00" };
    const noon = (day: number) => at(`2026-11-${day}T11:00:00Z`);
    expect(withinWorkingHours(office, noon(20), BERLIN)).toBe(true);
    expect(withinWorkingHours(office, noon(21), BERLIN)).toBe(false);
    expect(withinWorkingHours(office, noon(22), BERLIN)).toBe(false);
    expect(withinWorkingHours(office, noon(23), BERLIN)).toBe(true);
    const weekend = { ...office, days: [6, 7] };
    expect(withinWorkingHours(weekend, noon(20), BERLIN)).toBe(false);
    expect(withinWorkingHours(weekend, noon(21), BERLIN)).toBe(true);
  });

  test("the weekday is the person's local one, not the server's", () => {
    const office = { from: "09:00", to: "17:00" };
    expect(withinWorkingHours(office, at("2026-11-20T23:30:00Z"), "Asia/Tokyo")).toBe(false);
    expect(withinWorkingHours(office, at("2026-11-23T00:30:00Z"), "Asia/Tokyo")).toBe(true);
    expect(withinWorkingHours(office, at("2026-11-23T00:30:00Z"), "America/New_York")).toBe(false);
    expect(withinWorkingHours(office, at("2026-11-21T00:30:00Z"), "America/New_York")).toBe(false);
    expect(withinWorkingHours(office, at("2026-11-20T21:30:00Z"), "America/New_York")).toBe(true);
  });

  test("a window across midnight belongs to the day it starts on", () => {
    const late = { from: "22:00", to: "06:00", days: [5] };
    expect(withinWorkingHours(late, at("2026-11-20T23:00:00Z"), "UTC")).toBe(true);
    expect(withinWorkingHours(late, at("2026-11-21T03:00:00Z"), "UTC")).toBe(true);
    expect(withinWorkingHours(late, at("2026-11-21T23:00:00Z"), "UTC")).toBe(false);
    expect(withinWorkingHours(late, at("2026-11-20T03:00:00Z"), "UTC")).toBe(false);
    expect(iso(nextWorkingStart(late, at("2026-11-21T07:00:00Z"), "UTC"))).toBe(
      "2026-11-27T22:00:00.000Z",
    );
  });

  test("outside the window the push is held until the next start on a working day", () => {
    const schedule = { mode: "working_hours" as const, from: "09:00", to: "17:00" };
    const decide = (now: string, days?: number[]) =>
      decidePush({
        schedule: days ? { ...schedule, days } : schedule,
        timezone: BERLIN,
        now: at(now),
        last_digest_at: null,
      });
    expect(decide("2026-11-20T10:00:00Z")).toEqual({ deliver: "all", digest: false });
    expect(decide("2026-11-19T18:00:00Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-20T08:00:00Z"),
    });
    expect(decide("2026-11-20T18:00:00Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-23T08:00:00Z"),
    });
    expect(decide("2026-11-21T10:00:00Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-23T08:00:00Z"),
    });
    expect(decide("2026-11-20T18:00:00Z", EVERY_DAY)).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-21T08:00:00Z"),
    });
    expect(decide("2026-11-20T05:00:00Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-20T08:00:00Z"),
    });
    expect(decide("2026-11-20T10:00:00Z", [3])).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-25T08:00:00Z"),
    });
  });

  test("the next start follows the clock change in spring and autumn", () => {
    const schedule = {
      mode: "working_hours" as const,
      from: "09:00",
      to: "17:00",
      days: EVERY_DAY,
    };
    const next = (now: string) => {
      const decision = decidePush({
        schedule,
        timezone: BERLIN,
        now: at(now),
        last_digest_at: null,
      });
      return decision.deliver === "held" ? iso(decision.next_delivery) : "delivered";
    };
    expect(next("2026-03-28T20:00:00Z")).toBe("2026-03-29T07:00:00.000Z");
    expect(next("2026-03-29T06:59:00Z")).toBe("2026-03-29T07:00:00.000Z");
    expect(next("2026-03-29T07:00:00Z")).toBe("delivered");
    expect(next("2026-10-24T20:00:00Z")).toBe("2026-10-25T08:00:00.000Z");
    expect(next("2026-10-25T07:30:00Z")).toBe("2026-10-25T08:00:00.000Z");
    expect(next("2026-10-25T08:00:00Z")).toBe("delivered");
  });

  test("a weekend that contains a clock change still ends on Monday at the local start", () => {
    const schedule = { mode: "working_hours" as const, from: "09:00", to: "17:00" };
    const next = (now: string, timezone: string) => {
      const decision = decidePush({ schedule, timezone, now: at(now), last_digest_at: null });
      return decision.deliver === "held" ? iso(decision.next_delivery) : "delivered";
    };
    expect(next("2026-03-27T17:00:00Z", BERLIN)).toBe("2026-03-30T07:00:00.000Z");
    expect(next("2026-10-23T16:00:00Z", BERLIN)).toBe("2026-10-26T08:00:00.000Z");
    expect(next("2026-03-06T23:00:00Z", "America/New_York")).toBe("2026-03-09T13:00:00.000Z");
    expect(next("2026-10-30T22:00:00Z", "America/New_York")).toBe("2026-11-02T14:00:00.000Z");
  });

  test("a window that starts or ends in a changed hour keeps its length honest", () => {
    const early = { from: "02:30", to: "04:00", days: EVERY_DAY };
    expect(withinWorkingHours(early, at("2026-03-29T01:29:00Z"), BERLIN)).toBe(false);
    expect(withinWorkingHours(early, at("2026-03-29T01:30:00Z"), BERLIN)).toBe(true);
    expect(withinWorkingHours(early, at("2026-03-29T01:59:00Z"), BERLIN)).toBe(true);
    expect(withinWorkingHours(early, at("2026-03-29T02:00:00Z"), BERLIN)).toBe(false);
    expect(withinWorkingHours(early, at("2026-10-25T00:29:00Z"), BERLIN)).toBe(false);
    expect(withinWorkingHours(early, at("2026-10-25T00:30:00Z"), BERLIN)).toBe(true);
    expect(withinWorkingHours(early, at("2026-10-25T01:30:00Z"), BERLIN)).toBe(true);
    expect(withinWorkingHours(early, at("2026-10-25T02:59:00Z"), BERLIN)).toBe(true);
    expect(withinWorkingHours(early, at("2026-10-25T03:00:00Z"), BERLIN)).toBe(false);
  });

  test("the person's zone decides, not the server's", () => {
    const schedule = { mode: "working_hours" as const, from: "09:00", to: "17:00" };
    const now = at("2026-11-20T15:30:00Z");
    expect(decidePush({ schedule, timezone: BERLIN, now, last_digest_at: null }).deliver).toBe(
      "all",
    );
    expect(
      decidePush({ schedule, timezone: "Asia/Tokyo", now, last_digest_at: null }).deliver,
    ).toBe("held");
    expect(
      decidePush({ schedule, timezone: "America/Los_Angeles", now, last_digest_at: null }).deliver,
    ).toBe("held");
    expect(
      decidePush({ schedule, timezone: "Mars/Olympus", now, last_digest_at: null }).deliver,
    ).toBe("all");
  });
});

describe("daily summary", () => {
  const schedule = { mode: "daily_digest" as const, at: "09:00" };

  test("one summary per day at the chosen time, late when the engine was down", () => {
    const decide = (now: string, last: string | null) =>
      decidePush({
        schedule,
        timezone: BERLIN,
        now: at(now),
        last_digest_at: last ? at(last) : null,
      });
    expect(decide("2026-11-20T07:59:00Z", "2026-11-19T08:00:10Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-20T08:00:00Z"),
    });
    expect(decide("2026-11-20T08:00:00Z", "2026-11-19T08:00:10Z")).toEqual({
      deliver: "all",
      digest: true,
    });
    expect(decide("2026-11-20T08:05:00Z", "2026-11-20T08:00:00Z")).toEqual({
      deliver: "held",
      next_delivery: at("2026-11-21T08:00:00Z"),
    });
    expect(decide("2026-11-20T13:00:00Z", "2026-11-19T08:00:10Z")).toEqual({
      deliver: "all",
      digest: true,
    });
    expect(decide("2026-11-20T13:00:00Z", null)).toEqual({ deliver: "all", digest: true });
  });

  test("the summary time moves with the clock change", () => {
    expect(iso(lastOccurrence("09:00", at("2026-03-29T12:00:00Z"), BERLIN))).toBe(
      "2026-03-29T07:00:00.000Z",
    );
    expect(iso(lastOccurrence("09:00", at("2026-03-29T06:00:00Z"), BERLIN))).toBe(
      "2026-03-28T08:00:00.000Z",
    );
    expect(iso(nextOccurrence("09:00", at("2026-10-24T12:00:00Z"), BERLIN))).toBe(
      "2026-10-25T08:00:00.000Z",
    );
    expect(iso(nextOccurrence("02:30", at("2026-03-28T12:00:00Z"), BERLIN))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(iso(nextOccurrence("02:30", at("2026-10-24T12:00:00Z"), BERLIN))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(iso(nextOccurrence("02:30", at("2026-10-25T00:30:00Z"), BERLIN))).toBe(
      "2026-10-26T01:30:00.000Z",
    );
  });

  test("immediately never holds anything", () => {
    expect(
      decidePush({
        schedule: { mode: "immediately" },
        timezone: BERLIN,
        now: at("2026-11-20T02:00:00Z"),
        last_digest_at: null,
      }),
    ).toEqual({ deliver: "all", digest: false });
  });
});

describe("what may break through quiet hours", () => {
  test("a stopped or auto-paused workflow, schedule or task is critical only in production", () => {
    for (const reason of ["schedule_auto_paused", "execution_authority_expired"]) {
      const stopped = { class: "stopped", reason };
      expect(
        isCriticalPush({ ...stopped, subject: { kind: "workflow", environment: "prod" } }),
      ).toBe(true);
      expect(
        isCriticalPush({ ...stopped, subject: { kind: "workflow", environment: "dev" } }),
      ).toBe(false);
      expect(isCriticalPush({ ...stopped, subject: { kind: "workflow" } })).toBe(false);
    }
    const task = { class: "stopped", reason: "task_owner_unavailable" };
    expect(isCriticalPush({ ...task, subject: { kind: "task", environment: "prod" } })).toBe(true);
    expect(isCriticalPush({ ...task, subject: { kind: "task", environment: "dev" } })).toBe(false);
  });

  test("the environment of the subject wins over the one of an approval", () => {
    const item = { class: "stopped", reason: "execution_authority_required" };
    expect(
      isCriticalPush({
        ...item,
        subject: { kind: "workflow", environment: "dev" },
        approval: { environment: "prod" },
      }),
    ).toBe(false);
    expect(
      isCriticalPush({ ...item, subject: { kind: "workflow" }, approval: { environment: "prod" } }),
    ).toBe(true);
  });

  test("an unreadable secret is critical in every environment", () => {
    for (const environment of ["dev", "prod", undefined] as const)
      expect(
        isCriticalPush({
          class: "failing",
          reason: "secret_unreadable",
          subject: { kind: "secret", environment },
        }),
      ).toBe(true);
  });

  test("everything else waits", () => {
    for (const item of [
      { class: "failing", reason: "failing", subject: { kind: "workflow", environment: "prod" } },
      {
        class: "decide",
        reason: "version_awaiting_approval",
        subject: { kind: "workflow", environment: "prod" },
      },
      { class: "stopped", reason: "risk_critical", subject: { kind: "settings" } },
      { class: "stopped", reason: "task_owner_unavailable", subject: { kind: "task" } },
      {
        class: "failing",
        reason: "needs_reauth",
        subject: { kind: "connector", environment: "prod" },
      },
      { class: "stopped", reason: "spend_limit_reached", subject: null },
    ] as const) {
      expect(isCriticalPush(item)).toBe(false);
    }
  });

  test("the reasons that wait for someone's approval are named", () => {
    for (const reason of [
      "version_awaiting_approval",
      "execution_authority_required",
      "approval_expiring",
      "task_grant_required",
      "task_grant_expiring",
    ]) {
      expect(needsApproval({ reason })).toBe(true);
    }
    expect(needsApproval({ reason: "failing" })).toBe(false);
    expect(needsApproval({ reason: "awaiting_answer" })).toBe(false);
  });
});
