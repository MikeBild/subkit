// Unit tests for the `--since` relative time parsing logic used by the
// `sk audit query` command (apps/sk/src/commands/audit.ts).
//
// The parsing logic is mirrored inline here for isolation — no engine,
// no Postgres, no external dependencies.

import { describe, expect, test } from "bun:test";

// Mirror of the parsing logic from apps/sk/src/commands/audit.ts:
// If the value matches <number><unit> where unit is m/h/d, subtract that
// duration from now and return an ISO-8601 string. Otherwise return the
// raw value unchanged (ISO passthrough).
function parseSince(raw: string): string {
  const relative = raw.match(/^(\d+)(m|h|d)$/);
  if (relative) {
    const [, num, unit] = relative;
    const ms = Number(num) * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    return new Date(Date.now() - ms).toISOString();
  }
  return raw;
}

// Tolerance for timing assertions: 5 seconds is generous enough to survive
// slow CI runners without creating fragile millisecond-exact comparisons.
const TOLERANCE_MS = 5_000;

describe("parseSince — relative time expressions", () => {
  test("'10m' resolves to approximately 10 minutes ago", () => {
    const before = Date.now();
    const result = parseSince("10m");
    const after = Date.now();

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const ts = new Date(result).getTime();
    const expectedLow = before - 600_000 - TOLERANCE_MS;
    const expectedHigh = after - 600_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("'1h' resolves to approximately 1 hour ago", () => {
    const before = Date.now();
    const result = parseSince("1h");
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 3_600_000 - TOLERANCE_MS;
    const expectedHigh = after - 3_600_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("'7d' resolves to approximately 7 days ago", () => {
    const before = Date.now();
    const result = parseSince("7d");
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
    const before = Date.now();
    const result = parseSince("24h");
    const after = Date.now();

    const ts = new Date(result).getTime();
    const expectedLow = before - 86_400_000 - TOLERANCE_MS;
    const expectedHigh = after - 86_400_000 + TOLERANCE_MS;
    expect(ts).toBeGreaterThanOrEqual(expectedLow);
    expect(ts).toBeLessThanOrEqual(expectedHigh);
  });

  test("parseSince('1h') is lexicographically less than parseSince('10m')", () => {
    // 1 hour ago is earlier in time than 10 minutes ago, so its ISO string
    // sorts before the 10-minute one.
    const oneHour = parseSince("1h");
    const tenMin = parseSince("10m");
    expect(oneHour < tenMin).toBe(true);
  });

  test("parseSince('1m') produces a valid Date close to now minus 60 seconds", () => {
    const before = Date.now();
    const result = parseSince("1m");
    const after = Date.now();

    const ts = new Date(result).getTime();
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before - 60_000 - TOLERANCE_MS);
    expect(ts).toBeLessThanOrEqual(after - 60_000 + TOLERANCE_MS);
  });
});

describe("parseSince — edge cases", () => {
  test("zero minutes '0m' resolves to approximately now", () => {
    const before = Date.now();
    const result = parseSince("0m");
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
    const before = Date.now();
    const result = parseSince("365d");
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
