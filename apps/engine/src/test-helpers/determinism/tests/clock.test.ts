import { afterEach, describe, expect, it } from "bun:test";
import {
  createDeterministicClock,
  FROZEN_NOW,
  getTestNow,
  installClock,
  restoreClock,
  setTestNow,
} from "../clock.ts";

describe("clock", () => {
  afterEach(() => setTestNow(null));

  it("FROZEN_NOW is stable across runs", () => {
    expect(FROZEN_NOW).toBe(1_700_000_000_000);
  });

  it("createDeterministicClock starts at the given time", () => {
    const clock = createDeterministicClock(1000);
    expect(clock.now()).toBe(1000);
  });

  it("advanceBy moves the clock forward monotonically", () => {
    const clock = createDeterministicClock(0);
    expect(clock.advanceBy(5)).toBe(5);
    expect(clock.advanceBy(10)).toBe(15);
    expect(clock.now()).toBe(15);
  });

  it("setTo jumps to an exact value", () => {
    const clock = createDeterministicClock(0);
    expect(clock.setTo(42)).toBe(42);
    expect(clock.now()).toBe(42);
  });

  it("getTestNow defaults to real Date.now when no override is installed", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const now = getTestNow();
    expect(now).toBeGreaterThanOrEqual(before);
  });

  it("installClock routes getTestNow through the deterministic clock", () => {
    const clock = createDeterministicClock(FROZEN_NOW);
    installClock(clock);
    expect(getTestNow()).toBe(FROZEN_NOW);
    clock.advanceBy(123);
    expect(getTestNow()).toBe(FROZEN_NOW + 123);
  });

  it("restoreClock returns to the prior provider", () => {
    const clock = createDeterministicClock(1);
    const prev = installClock(clock);
    expect(getTestNow()).toBe(1);
    restoreClock(prev);
    // Back to real time — should be a large positive number, not 1.
    expect(getTestNow()).toBeGreaterThan(1);
  });
});
