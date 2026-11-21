import { describe, expect, test } from "bun:test";
import { idleStep, OWNER_IDLE } from "./owner-idle.ts";

describe("idleStep", () => {
  test("acts once the person has been idle for the minimum", () => {
    expect(idleStep(1, 0)).toEqual({ kind: "act" });
    expect(idleStep(7, 14_999)).toEqual({ kind: "act" });
  });

  test("waits for the missing idle time while recent input exists", () => {
    expect(idleStep(0, 0)).toEqual({ kind: "wait", wait_ms: 1000 });
    expect(idleStep(0.4, 0)).toEqual({ kind: "wait", wait_ms: 600 });
  });

  test("never waits less than one poll", () => {
    expect(idleStep(0.9, 0)).toEqual({ kind: "wait", wait_ms: 250 });
  });

  test("never waits past the limit", () => {
    expect(idleStep(0, 14_500)).toEqual({ kind: "wait", wait_ms: 500 });
    expect(idleStep(0, 14_999)).toEqual({ kind: "wait", wait_ms: 1 });
  });

  test("hands over with owner_active once the limit is spent", () => {
    expect(idleStep(0, 15_000)).toEqual({ kind: "owner_active" });
    expect(idleStep(0, 16_000)).toEqual({ kind: "owner_active" });
  });

  test("an unknown idle time counts as recent input", () => {
    expect(idleStep(null, 0)).toEqual({ kind: "wait", wait_ms: 1000 });
    expect(idleStep(Number.NaN, 0)).toEqual({ kind: "wait", wait_ms: 1000 });
    expect(idleStep(Number.POSITIVE_INFINITY, 0)).toEqual({ kind: "wait", wait_ms: 1000 });
    expect(idleStep(null, 15_000)).toEqual({ kind: "owner_active" });
  });

  test("follows a custom policy", () => {
    const policy = { min_idle_s: 3, max_wait_ms: 2000, poll_ms: 100 };
    expect(idleStep(2, 0, policy)).toEqual({ kind: "wait", wait_ms: 1000 });
    expect(idleStep(0, 0, policy)).toEqual({ kind: "wait", wait_ms: 2000 });
    expect(idleStep(3, 0, policy)).toEqual({ kind: "act" });
  });

  test("defaults to one second idle, fifteen seconds wait and a quarter-second poll", () => {
    expect(OWNER_IDLE).toEqual({ min_idle_s: 1, max_wait_ms: 15_000, poll_ms: 250 });
  });
});

describe("idleStep without a minimum", () => {
  test("acts at once, also when the idle time is unknown", () => {
    expect(idleStep(null, 0, { min_idle_s: 0, max_wait_ms: 1000, poll_ms: 100 })).toEqual({
      kind: "act",
    });
  });
});
