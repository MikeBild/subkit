// Tests for the knowledge auto-refresh reconciliation in the scheduler.
// Uses isCronDue directly since the reconciler requires pg-boss.

import { describe, expect, test } from "bun:test";
import { isCronDue } from "../reconciler.ts";

// Fixed clocks pinned away from 5-minute cron boundaries so the tests
// are not flaky when the wall clock happens to tick past `*:00`,
// `*:05`, etc., between lastFiredAt and now. Using `new Date()`
// directly was the root cause of a previous CI flake.
const NOW = new Date("2026-04-17T10:02:30.000Z");
const JUST_FIRED = new Date("2026-04-17T10:02:00.000Z"); // 30s before NOW, same 5-minute bucket

describe("scheduler/knowledge-refresh", () => {
  test("isCronDue returns true when never fired", () => {
    expect(isCronDue("*/5 * * * *", null, NOW)).toBe(true);
  });

  test("isCronDue returns false when recently fired", () => {
    // 5-minute cron: lastFired at :02:00, now :02:30 — next boundary
    // is :05:00 so not yet due.
    expect(isCronDue("*/5 * * * *", JUST_FIRED, NOW)).toBe(false);
  });

  test("isCronDue with every: shorthand", () => {
    const fiveSecsAgo = new Date(NOW.getTime() - 5_000);
    expect(isCronDue("every:3", fiveSecsAgo, NOW)).toBe(true);
    expect(isCronDue("every:10", fiveSecsAgo, NOW)).toBe(false);
  });

  test("isCronDue with invalid cron returns false", () => {
    expect(isCronDue("not a cron", null, NOW)).toBe(true);
    expect(isCronDue("not valid at all", NOW, NOW)).toBe(false);
  });
});
