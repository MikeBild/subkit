import { describe, expect, test } from "bun:test";
import { RESTART_LIMIT, RESTART_WINDOW_MS, restartPlan } from "./restart-policy.ts";

const NOW = 10 * RESTART_WINDOW_MS;

describe("restartPlan", () => {
  test("the first crash restarts after a second and is remembered", () => {
    expect(restartPlan([], NOW)).toEqual({ delay_ms: 1_000, crashes: [NOW] });
  });

  test("each recent crash doubles the wait", () => {
    expect(restartPlan([NOW - 10, NOW - 5], NOW)).toEqual({
      delay_ms: 4_000,
      crashes: [NOW - 10, NOW - 5, NOW],
    });
    const four = [NOW - 4, NOW - 3, NOW - 2, NOW - 1];
    expect(restartPlan(four, NOW)?.delay_ms).toBe(16_000);
  });

  test("crashes outside the window or in the future are forgotten", () => {
    expect(restartPlan([NOW - RESTART_WINDOW_MS], NOW)).toEqual({
      delay_ms: 1_000,
      crashes: [NOW],
    });
    expect(restartPlan([NOW - RESTART_WINDOW_MS + 1], NOW)?.delay_ms).toBe(2_000);
    expect(restartPlan([NOW + 1], NOW)).toEqual({ delay_ms: 1_000, crashes: [NOW] });
    expect(restartPlan([NOW], NOW)?.delay_ms).toBe(2_000);
  });

  test("gives up after too many recent crashes", () => {
    const crashes = Array.from({ length: RESTART_LIMIT }, (_, index) => NOW - index);
    expect(restartPlan(crashes, NOW)).toBeNull();
    expect(restartPlan(crashes.slice(1), NOW)).not.toBeNull();
  });
});
