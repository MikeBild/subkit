// Pre-expiry refresh check. Returns `true` when the caller should
// refresh BEFORE issuing the next request, instead of refresh-on-401.
// Default buffer: 5 minutes.

import { describe, expect, test } from "bun:test";
import { isTokenExpired } from "../client.ts";

const TEST_NOW_MS = 1_700_000_000_000;

describe("isTokenExpired", () => {
  test("returns true when bundle is null", () => {
    expect(isTokenExpired(null)).toBe(true);
  });

  test("returns true when expires_at is null (long-lived token)", () => {
    expect(isTokenExpired({ expires_at: null })).toBe(true);
  });

  test("returns true within the buffer window", () => {
    const inOneMinute = new Date(TEST_NOW_MS + 60_000);
    expect(isTokenExpired({ expires_at: inOneMinute })).toBe(true);
  });

  test("returns false safely outside the buffer", () => {
    const inOneHour = new Date(TEST_NOW_MS + 60 * 60_000);
    expect(isTokenExpired({ expires_at: inOneHour })).toBe(false);
  });

  test("accepts ISO string expires_at", () => {
    const inOneHour = new Date(TEST_NOW_MS + 60 * 60_000).toISOString();
    expect(isTokenExpired({ expires_at: inOneHour })).toBe(false);
  });

  test("respects custom buffer", () => {
    const inTwoMinutes = new Date(TEST_NOW_MS + 2 * 60_000);
    // 30s buffer: 2min away is safely outside the window
    expect(isTokenExpired({ expires_at: inTwoMinutes }, 30_000)).toBe(false);
    // 5min buffer (default): 2min away is inside the window
    expect(isTokenExpired({ expires_at: inTwoMinutes })).toBe(true);
  });

  test("returns true for invalid date string", () => {
    expect(isTokenExpired({ expires_at: "not a date" })).toBe(true);
  });
});
