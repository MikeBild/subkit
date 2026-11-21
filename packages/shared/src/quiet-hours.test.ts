import { describe, expect, test } from "bun:test";
import { DEFAULT_QUIET_HOURS, DEFAULT_WORKING_DAYS, parseClock } from "./quiet-hours.ts";

describe("quiet hours", () => {
  test("quiet hours run from ten in the evening to seven in the morning", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ start: "22:00", end: "07:00" });
  });

  test("the working week is Monday to Friday", () => {
    expect(DEFAULT_WORKING_DAYS).toEqual([1, 2, 3, 4, 5]);
  });

  test("a clock is HH:MM in 24 hours with a leading zero", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("19:05")).toBe(1145);
    expect(parseClock("23:59")).toBe(1439);
    for (const bad of ["24:00", "7:30", "07:60", "07:3", " 07:30", "07:30 ", "", null, 730])
      expect(parseClock(bad)).toBeNull();
    expect(parseClock(new String("07:30"))).toBeNull();
  });
});
