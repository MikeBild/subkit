import { describe, expect, test } from "bun:test";
import { isCronDue, parseCronExpression } from "./cron.ts";

const now = new Date("2026-01-01T00:01:00.000Z");
const lastFiredAt = new Date("2026-01-01T00:00:00.000Z");

describe("every:<seconds> shorthand", () => {
  test.each([
    "every:15seconds",
    "every:25秒",
    "every:15s",
    "every:1e3",
    "every: 15x",
    "every:seconds",
    "every:-5",
    "every:0",
    "every:",
  ])("rejects %p", (expression) => {
    expect(parseCronExpression(expression)).toEqual({
      ok: false,
      mode: "every",
      reason: `invalid every expression: ${expression}`,
    });
  });

  test.each([
    ["every:15", 15],
    ["every:0.5", 0.5],
    [" every:60 ", 60],
    ["every: 30", 30],
  ])("accepts %p", (expression, everySeconds) => {
    expect(parseCronExpression(expression)).toEqual({ ok: true, mode: "every", everySeconds });
  });

  test("never fires a stored malformed every expression", () => {
    expect(isCronDue("every:15seconds", lastFiredAt, now)).toBe(false);
    expect(isCronDue("every:25秒", null, now)).toBe(false);
  });

  test("fires a valid every expression once the interval elapsed", () => {
    expect(isCronDue("every:15", lastFiredAt, now)).toBe(true);
    expect(isCronDue("every:120", lastFiredAt, now)).toBe(false);
    expect(isCronDue("every:15", null, now)).toBe(true);
  });
});
