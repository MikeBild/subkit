import { describe, expect, test } from "bun:test";
import { applyJitter, BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from "./backoff.ts";

describe("backoffDelay", () => {
  test("doubles per attempt between half and the full ceiling", () => {
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(0, 1)).toBe(1_000);
    expect(backoffDelay(1, 1)).toBe(2_000);
    expect(backoffDelay(3, 0.5)).toBe(6_000);
  });

  test("stops at the maximum and clamps attempt and jitter", () => {
    expect(backoffDelay(10, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(99, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(-1, 2)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(0, -1)).toBe(500);
  });

  test("takes its own base and maximum", () => {
    expect(backoffDelay(0, 1, { baseMs: 500 })).toBe(500);
    expect(backoffDelay(2, 1, { baseMs: 500, maxMs: 1_500 })).toBe(1_500);
    expect(backoffDelay(5, 1, { maxMs: 10_000 })).toBe(10_000);
    expect(backoffDelay(40, 1, { baseMs: 1, maxMs: Number.MAX_SAFE_INTEGER })).toBe(65_536);
  });
});

describe("backoffDelay options", () => {
  test("grows by the given factor", () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) =>
      backoffDelay(attempt, 0, { baseMs: 120_000, factor: 3, maxMs: 3_240_000, jitter: "none" }),
    );
    expect(delays).toEqual([120_000, 360_000, 1_080_000, 3_240_000, 3_240_000]);
  });

  test("none ignores the random sample", () => {
    expect(backoffDelay(2, 0, { jitter: "none" })).toBe(4_000);
    expect(backoffDelay(2, 1, { jitter: "none" })).toBe(4_000);
  });

  test("full spreads between zero and the ceiling", () => {
    expect(backoffDelay(2, 0, { jitter: "full" })).toBe(0);
    expect(backoffDelay(2, 0.25, { jitter: "full" })).toBe(1_000);
    expect(backoffDelay(2, 1, { jitter: "full" })).toBe(4_000);
  });

  test("symmetric spreads around the ceiling and caps before the jitter", () => {
    expect(backoffDelay(2, 0, { jitter: { symmetric: 0.2 } })).toBe(3_200);
    expect(backoffDelay(2, 0.5, { jitter: { symmetric: 0.2 } })).toBe(4_000);
    expect(backoffDelay(2, 1, { jitter: { symmetric: 0.2 } })).toBe(4_800);
    expect(backoffDelay(9, 1, { jitter: { symmetric: 0.2 } })).toBe(72_000);
    expect(backoffDelay(0, 0, { jitter: { symmetric: 2 } })).toBe(0);
  });

  test("keeps fractions when rounding is off and rounds them otherwise", () => {
    const delay = backoffDelay(2, 0, { baseMs: 333, jitter: { symmetric: 0.2 }, round: false });
    expect(delay).toBeCloseTo(1_065.6, 6);
    expect(backoffDelay(2, 0, { baseMs: 333, jitter: { symmetric: 0.2 } })).toBe(1_066);
  });
});

describe("applyJitter", () => {
  test("clamps the random sample", () => {
    expect(applyJitter(1_000, -1, "full")).toBe(0);
    expect(applyJitter(1_000, 2, { symmetric: 0.1 })).toBe(1_100);
  });
});
