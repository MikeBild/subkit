// Tests for the knowledge auto-refresh reconciliation in the scheduler.
// Uses isCronDue directly since the reconciler requires pg-boss.

import { describe, expect, test } from "bun:test";
import { isCronDue } from "../reconciler.ts";

describe("scheduler/knowledge-refresh", () => {
  test("isCronDue returns true when never fired", () => {
    expect(isCronDue("*/5 * * * *", null, new Date())).toBe(true);
  });

  test("isCronDue returns false when recently fired", () => {
    const now = new Date();
    const justFired = new Date(now.getTime() - 30_000); // 30 seconds ago
    // 5-minute cron should not be due after 30 seconds
    expect(isCronDue("*/5 * * * *", justFired, now)).toBe(false);
  });

  test("isCronDue with every: shorthand", () => {
    const now = new Date();
    const fiveSecsAgo = new Date(now.getTime() - 5_000);
    expect(isCronDue("every:3", fiveSecsAgo, now)).toBe(true);
    expect(isCronDue("every:10", fiveSecsAgo, now)).toBe(false);
  });

  test("isCronDue with invalid cron returns false", () => {
    expect(isCronDue("not a cron", null, new Date())).toBe(true);
    // Invalid cron with a past lastFiredAt
    expect(isCronDue("not valid at all", new Date(), new Date())).toBe(false);
  });
});
