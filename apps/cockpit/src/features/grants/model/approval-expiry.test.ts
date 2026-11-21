import { describe, expect, test } from "bun:test";
import { approvalExpiryDays, approvalExpiryKey } from "@/features/grants/model/approval-expiry";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const HOUR = 3_600_000;

describe("approval expiry strip", () => {
  test("stays hidden without an end, after the end and beyond a week", () => {
    expect(approvalExpiryDays(null, NOW)).toBeNull();
    expect(approvalExpiryDays("not a date", NOW)).toBeNull();
    expect(approvalExpiryDays(new Date(NOW - HOUR).toISOString(), NOW)).toBeNull();
    expect(approvalExpiryDays(new Date(NOW + 8 * 24 * HOUR).toISOString(), NOW)).toBeNull();
  });

  test("counts started days like the attention list does", () => {
    expect(approvalExpiryDays(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toBe(1);
    expect(approvalExpiryDays(new Date(NOW + 30 * HOUR).toISOString(), NOW)).toBe(2);
    expect(approvalExpiryDays(new Date(NOW + 6.5 * 24 * HOUR).toISOString(), NOW)).toBe(7);
  });

  test("picks one sentence per distance", () => {
    expect(approvalExpiryKey(0)).toBe("approvalExpiry.today");
    expect(approvalExpiryKey(1)).toBe("approvalExpiry.tomorrow");
    expect(approvalExpiryKey(4)).toBe("approvalExpiry.days");
  });
});
