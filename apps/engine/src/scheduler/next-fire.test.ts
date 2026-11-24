import { describe, expect, test } from "bun:test";
import { calendarGateSkipReason } from "./calendar-gates.ts";
import { GATE_SEARCH_DAYS, nextScheduleFire } from "./next-fire.ts";
import { isCronDue } from "./reconciler.ts";

const created = new Date("2026-01-01T00:00:00.000Z");

describe("nextScheduleFire", () => {
  test.each([
    { input: { business_days_only: true }, expected: "2026-03-16T18:00:00.000Z" },
    { input: { skip_dates: ["2026-03-14"] }, expected: "2026-03-15T18:00:00.000Z" },
  ])("a missed Friday run does not fire on a blocked Saturday: $input", ({ input, expected }) => {
    const now = new Date("2026-03-14T09:00:00.000Z");
    const last = new Date("2026-03-12T18:00:00.000Z");
    const next = nextScheduleFire(
      {
        cron: "0 19 * * *",
        timezone: "Europe/Berlin",
        input,
        last_enqueued_at: last,
        created_at: created,
      },
      now,
    );
    expect(next).toBe(expected);
    const at = new Date(next ?? "");
    expect(calendarGateSkipReason(at, "Europe/Berlin", input)).toBeNull();
    expect(isCronDue("0 19 * * *", last, at, "Europe/Berlin")).toBe(true);
  });

  test("a cron schedule fires when the reconciler's due check first turns true", () => {
    const now = new Date("2026-03-10T10:20:00.000Z");
    const last = new Date("2026-03-10T10:07:00.000Z");
    const next = nextScheduleFire(
      {
        cron: "7 * * * *",
        timezone: "UTC",
        input: null,
        last_enqueued_at: last,
        created_at: created,
      },
      now,
    );
    expect(next).toBe("2026-03-10T11:07:00.000Z");
    const at = new Date(next ?? "");
    expect(isCronDue("7 * * * *", last, at, "UTC")).toBe(true);
    expect(isCronDue("7 * * * *", last, new Date(at.getTime() - 60_000), "UTC")).toBe(false);
  });

  test("an active every:N schedule has a next fire", () => {
    const now = new Date("2026-03-10T10:00:00.000Z");
    expect(
      nextScheduleFire(
        {
          cron: "every:30",
          timezone: "UTC",
          input: null,
          last_enqueued_at: new Date("2026-03-10T09:59:50.000Z"),
          created_at: created,
        },
        now,
      ),
    ).toBe("2026-03-10T10:00:20.000Z");
    expect(
      nextScheduleFire(
        {
          cron: "every:30",
          timezone: "UTC",
          input: null,
          last_enqueued_at: null,
          created_at: created,
        },
        now,
      ),
    ).toBe("2026-03-10T10:00:30.000Z");
  });

  test("a business-days schedule on Friday evening next fires at Monday's cron slot, not Saturday", () => {
    const now = new Date("2026-03-13T19:00:00.000Z");
    const last = new Date("2026-03-13T18:00:00.000Z");
    const next = nextScheduleFire(
      {
        cron: "0 19 * * *",
        timezone: "Europe/Berlin",
        input: { business_days_only: true },
        last_enqueued_at: last,
        created_at: created,
      },
      now,
    );
    expect(next).toBe("2026-03-16T18:00:00.000Z");
    const at = new Date(next ?? "");
    expect(calendarGateSkipReason(at, "Europe/Berlin", { business_days_only: true })).toBeNull();
    expect(isCronDue("0 19 * * *", last, at, "Europe/Berlin")).toBe(true);
  });

  test("a skipped date moves the next fire to the next cron occurrence on an open date, not local midnight", () => {
    const now = new Date("2026-11-24T07:42:00.000Z");
    const next = nextScheduleFire(
      {
        cron: "26,28 13 * * *",
        timezone: "Asia/Kathmandu",
        input: { skip_dates: ["2026-11-24"] },
        last_enqueued_at: new Date("2026-11-24T07:41:00.000Z"),
        created_at: created,
      },
      now,
    );
    expect(next).toBe("2026-11-25T07:41:00.000Z");
    const at = new Date(next ?? "");
    const dayBefore = new Date("2026-11-24T07:43:00.000Z");
    expect(isCronDue("26,28 13 * * *", dayBefore, at, "Asia/Kathmandu")).toBe(true);
    expect(
      isCronDue("26,28 13 * * *", dayBefore, new Date(at.getTime() - 60_000), "Asia/Kathmandu"),
    ).toBe(false);
  });

  test("gates closed beyond the search bound → null rather than a guess", () => {
    const now = new Date("2026-03-10T10:00:00.000Z");
    const skip_dates = Array.from({ length: GATE_SEARCH_DAYS + 5 }, (_, i) =>
      new Date(Date.UTC(2026, 2, 10 + i)).toISOString().slice(0, 10),
    );
    expect(
      nextScheduleFire(
        {
          cron: "0 12 * * *",
          timezone: "UTC",
          input: { skip_dates },
          last_enqueued_at: new Date("2026-03-09T12:00:00.000Z"),
          created_at: created,
        },
        now,
      ),
    ).toBeNull();
  });
});
