import { describe, expect, test } from "bun:test";
import { preserveCalendarGates } from "@/features/workflows/model/schedule-input";

describe("schedule input calendar gates", () => {
  test("an input edit keeps the saved exceptions and business-day rule", () => {
    expect(
      preserveCalendarGates(
        { batch: 17, skip_dates: ["2026-11-24"], business_days_only: true },
        { batch: 23 },
      ),
    ).toEqual({ batch: 23, skip_dates: ["2026-11-24"], business_days_only: true });
  });

  test("gates set in the new input win over the saved ones", () => {
    expect(
      preserveCalendarGates(
        { skip_dates: ["2026-11-24"], business_days_only: true },
        { skip_dates: [], business_days_only: false },
      ),
    ).toEqual({ skip_dates: [], business_days_only: false });
  });

  test("without saved gates the new input stays as built", () => {
    const built = { batch: 23 };
    expect(preserveCalendarGates({ batch: 17 }, built)).toBe(built);
    expect(preserveCalendarGates(null, built)).toBe(built);
    expect(preserveCalendarGates(undefined, undefined)).toBeUndefined();
  });

  test("a new input that is not an object stays as built", () => {
    expect(preserveCalendarGates({ skip_dates: ["2026-11-24"] }, "text")).toBe("text");
    expect(preserveCalendarGates({ skip_dates: ["2026-11-24"] }, [1, 2])).toEqual([1, 2]);
    expect(preserveCalendarGates("text", { batch: 23 })).toEqual({ batch: 23 });
  });

  test("an empty new input still carries the saved gates", () => {
    expect(preserveCalendarGates({ skip_dates: ["2026-11-24"] }, undefined)).toEqual({
      skip_dates: ["2026-11-24"],
    });
  });
});
