import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_RETRY_DELAYS_MS, nextDelayMs, setRetryDelays } from "./retry.ts";

function withRandom(value: number): void {
  spyOn(Math, "random").mockReturnValue(value);
}

afterEach(() => {
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
  setRetryDelays(null);
});

describe("outbound webhook retry schedule", () => {
  test("keeps the ladder at the midpoint", () => {
    withRandom(0.5);
    expect(DEFAULT_RETRY_DELAYS_MS.map((_, index) => nextDelayMs(index + 1))).toEqual([
      ...DEFAULT_RETRY_DELAYS_MS,
    ]);
  });

  test("spreads plus or minus 10 percent and rounds to whole milliseconds", () => {
    withRandom(0);
    expect(nextDelayMs(1)).toBe(54_000);
    expect(nextDelayMs(2)).toBe(270_000);
    withRandom(1);
    expect(nextDelayMs(1)).toBe(66_000);
    expect(nextDelayMs(7)).toBe(47_520_000);
    setRetryDelays([7]);
    withRandom(0.99);
    expect(nextDelayMs(1)).toBe(8);
  });

  test("returns nothing outside the ladder", () => {
    expect(nextDelayMs(0)).toBeNull();
    expect(nextDelayMs(DEFAULT_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });
});
