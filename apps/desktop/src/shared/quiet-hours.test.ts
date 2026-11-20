import { describe, expect, test } from "bun:test";
import { inQuietHours, muteReason, parseClock } from "./quiet-hours.ts";

const at = (hour: number, minute: number) => new Date(2026, 10, 20, hour, minute, 0, 0);

describe("quiet hours", () => {
  test("parses 24-hour clock values", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("7:00")).toBeNull();
    expect(parseClock(700)).toBeNull();
  });

  test("covers a window across midnight", () => {
    const quiet = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(quiet, at(21, 59))).toBe(false);
    expect(inQuietHours(quiet, at(22, 0))).toBe(true);
    expect(inQuietHours(quiet, at(3, 30))).toBe(true);
    expect(inQuietHours(quiet, at(6, 59))).toBe(true);
    expect(inQuietHours(quiet, at(7, 0))).toBe(false);
  });

  test("covers a window within one day", () => {
    const quiet = { enabled: true, start: "12:00", end: "13:30" };
    expect(inQuietHours(quiet, at(11, 59))).toBe(false);
    expect(inQuietHours(quiet, at(12, 0))).toBe(true);
    expect(inQuietHours(quiet, at(13, 29))).toBe(true);
    expect(inQuietHours(quiet, at(13, 30))).toBe(false);
  });

  test("is off when disabled, empty or malformed", () => {
    expect(inQuietHours({ enabled: false, start: "00:00", end: "23:59" }, at(12, 0))).toBe(false);
    expect(inQuietHours({ enabled: true, start: "08:00", end: "08:00" }, at(8, 0))).toBe(false);
    expect(inQuietHours({ enabled: true, start: "x", end: "08:00" }, at(7, 0))).toBe(false);
  });

  test("prefers an active pause over quiet hours", () => {
    const now = at(23, 0);
    const quietHours = { enabled: true, start: "22:00", end: "07:00" };
    expect(muteReason({ quietHours, pauseUntil: now.getTime() + 1 }, now)).toBe("paused");
    expect(muteReason({ quietHours, pauseUntil: now.getTime() }, now)).toBe("quiet-hours");
    expect(muteReason({ quietHours, pauseUntil: null }, at(12, 0))).toBeNull();
  });
});
