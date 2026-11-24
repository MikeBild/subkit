import { describe, expect, test } from "bun:test";
import { pausesOnly } from "./schedule-update.ts";

describe("a schedule write that only pauses", () => {
  test("pausing alone skips the input check", () => {
    expect(pausesOnly({ paused: true })).toBe(true);
  });

  test("resume, input, cron, timezone and mode writes keep the input check", () => {
    expect(pausesOnly({ paused: false })).toBe(false);
    expect(pausesOnly({})).toBe(false);
    expect(pausesOnly({ paused: true, input: {} })).toBe(false);
    expect(pausesOnly({ paused: true, cron: "0 8 * * *" })).toBe(false);
    expect(pausesOnly({ paused: true, timezone: "UTC" })).toBe(false);
    expect(pausesOnly({ paused: true, execution_mode: "prod" })).toBe(false);
  });
});
