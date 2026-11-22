import { describe, expect, test } from "bun:test";

function parseSince(raw: string): string {
  const relative = raw.match(/^(\d+)(m|h|d)$/);
  if (relative) {
    const [, num, unit] = relative;
    const ms = Number(num) * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    return new Date(Date.now() - ms).toISOString();
  }
  return raw;
}

const TOLERANCE_MS = 5_000;

describe("parseSince — relative time expressions", () => {
  test("'10m' resolves to approximately 10 minutes ago", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("10m");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const ts = new Date(result).getTime();
    const expectedLow = before - 600_000 - TOLERANCE_MS;
    const expectedHigh = after - 600_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("'1h' resolves to approximately 1 hour ago", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("1h");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 3_600_000 - TOLERANCE_MS;
    const expectedHigh = after - 3_600_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("'7d' resolves to approximately 7 days ago", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("7d");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 7 * 86_400_000 - TOLERANCE_MS;
    const expectedHigh = after - 7 * 86_400_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("ISO-8601 string passes through unchanged", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    expect(parseSince(iso)).toBe(iso);
  });

  test("'24h' resolves to approximately 24 hours ago", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("24h");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 86_400_000 - TOLERANCE_MS;
    const expectedHigh = after - 86_400_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("parseSince('1h') is lexicographically less than parseSince('10m')", () => {
    const oneHour = parseSince("1h");
    const tenMin = parseSince("10m");
    expect(oneHour < tenMin).toBe(true);
  });

  test("parseSince('1m') produces a valid Date close to now minus 60 seconds", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("1m");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before - 60_000 - TOLERANCE_MS);
    expect(ts).toBeLessThanOrEqual(after - 60_000 + TOLERANCE_MS);
  });
});

describe("parseSince — edge cases", () => {
  test("zero minutes '0m' resolves to approximately now", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("0m");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - TOLERANCE_MS);
    expect(ts).toBeLessThanOrEqual(after + TOLERANCE_MS);
  });

  test("arbitrary string with no unit returns the raw value", () => {
    expect(parseSince("yesterday")).toBe("yesterday");
    expect(parseSince("")).toBe("");
    expect(parseSince("1x")).toBe("1x");
  });

  test("large day count '365d' resolves to approximately 1 year ago", () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const before = Date.now();
    const result = parseSince("365d");
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 365 * 86_400_000 - TOLERANCE_MS;
    const expectedHigh = after - 365 * 86_400_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("result is always a valid ISO-8601 string for known relative formats", () => {
    for (const expr of ["1m", "30m", "2h", "48h", "1d", "30d"]) {
      const result = parseSince(expr);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isFinite(new Date(result).getTime())).toBe(true);
    }
  });
});
