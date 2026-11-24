import { describe, expect, test } from "bun:test";
import { approvalExpiryDays, approvalExpiryKey } from "@/features/grants/model/approval-expiry";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const HOUR = 3_600_000;
const BERLIN = "Europe/Berlin";
const at = (iso: string) => Date.parse(iso);

describe("approval expiry strip", () => {
  test("stays hidden without an end, after the end and beyond a week", () => {
    expect(approvalExpiryDays(null, NOW, BERLIN)).toBeNull();
    expect(approvalExpiryDays("not a date", NOW, BERLIN)).toBeNull();
    expect(approvalExpiryDays(new Date(NOW - HOUR).toISOString(), NOW, BERLIN)).toBeNull();
    expect(approvalExpiryDays(new Date(NOW).toISOString(), NOW, BERLIN)).toBeNull();
    expect(approvalExpiryDays(new Date(NOW + 8 * 24 * HOUR).toISOString(), NOW, BERLIN)).toBeNull();
  });

  test("says today for a deadline later on the same local date (#556)", () => {
    const now = at("2026-11-23T22:08:57Z");
    expect(approvalExpiryDays("2026-11-23T22:10:36Z", now, BERLIN)).toBe(0);
    expect(approvalExpiryDays("2026-11-23T22:59:59Z", now, BERLIN)).toBe(0);
    expect(approvalExpiryKey(0)).toBe("approvalExpiry.today");
  });

  test("counts calendar days in the display time zone, not elapsed 24h blocks", () => {
    const now = at("2026-11-23T22:08:57Z");
    expect(approvalExpiryDays("2026-11-23T23:00:00Z", now, BERLIN)).toBe(1);
    expect(approvalExpiryDays("2026-11-24T22:59:59Z", now, BERLIN)).toBe(1);
    expect(approvalExpiryDays("2026-11-24T23:00:00Z", now, BERLIN)).toBe(2);
    expect(approvalExpiryDays("2026-11-23T23:00:00Z", now, "UTC")).toBe(0);
    expect(approvalExpiryDays("2026-11-24T00:00:00Z", now, "UTC")).toBe(1);
  });

  test("stays exact across a daylight saving switch", () => {
    const beforeSpring = at("2026-03-28T23:00:00Z");
    expect(approvalExpiryDays("2026-03-29T21:59:00Z", beforeSpring, BERLIN)).toBe(0);
    expect(approvalExpiryDays("2026-03-29T22:00:00Z", beforeSpring, BERLIN)).toBe(1);
    const beforeAutumn = at("2026-10-24T22:30:00Z");
    expect(approvalExpiryDays("2026-10-25T22:59:00Z", beforeAutumn, BERLIN)).toBe(0);
    expect(approvalExpiryDays("2026-10-25T23:00:00Z", beforeAutumn, BERLIN)).toBe(1);
  });

  test("keeps the seven-day strip limit", () => {
    const now = at("2026-11-23T10:00:00Z");
    expect(approvalExpiryDays("2026-11-30T22:00:00Z", now, BERLIN)).toBe(7);
    expect(approvalExpiryDays("2026-11-30T23:00:00Z", now, BERLIN)).toBeNull();
  });

  test("picks one sentence per distance", () => {
    expect(approvalExpiryKey(0)).toBe("approvalExpiry.today");
    expect(approvalExpiryKey(1)).toBe("approvalExpiry.tomorrow");
    expect(approvalExpiryKey(4)).toBe("approvalExpiry.days");
  });
});
