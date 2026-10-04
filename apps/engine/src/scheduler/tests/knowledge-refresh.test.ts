import { describe, expect, test } from "bun:test";
import { isCronDue } from "../reconciler.ts";

const NOW = new Date("2026-04-17T10:02:30.000Z");
const JUST_FIRED = new Date("2026-04-17T10:02:00.000Z");

describe("scheduler/knowledge-refresh", () => {
  test("isCronDue returns true when never fired", () => {
    expect(isCronDue("*/5 * * * *", null, NOW)).toBe(true);
  });

  test("isCronDue returns false when recently fired", () => {
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
