import { describe, expect, test } from "bun:test";
import { HttpError } from "../../http/errors.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { resolveWindow, WINDOW_CAP_MS } from "./bucket-window.ts";

function detailsReason(e: unknown): string | undefined {
  if (!(e instanceof HttpError)) return undefined;
  return e.details?.reason as string | undefined;
}

const T0 = "2026-01-15T12:00:00.000Z";

function msAgo(refMs: number, deltaMs: number): string {
  return new Date(refMs - deltaMs).toISOString();
}
function msLater(refMs: number, deltaMs: number): string {
  return new Date(refMs + deltaMs).toISOString();
}

describe("resolveWindow — happy path", () => {
  test("parses a basic hour window without errors", () => {
    const from = "2026-01-15T06:00:00.000Z";
    const to = "2026-01-15T12:00:00.000Z";
    const w = resolveWindow({ bucket: "hour", from, to });
    expect(w.bucket).toBe("hour");
    expect(w.from.toISOString()).toBe(from);
    expect(w.to.toISOString()).toBe(to);
    expect(w.tz).toBe("UTC");
  });

  test("defaults to now when `to` is omitted (uses minute bucket to avoid cap)", () => {
    const before = getTestNow();
    const from = new Date(before - 60_000).toISOString();
    const w = resolveWindow({ bucket: "minute", from });
    const after = getTestNow();
    expect(w.to.getTime()).toBeGreaterThanOrEqual(before);
    expect(w.to.getTime()).toBeLessThanOrEqual(after + 50);
  });

  test("honours a custom tz", () => {
    const w = resolveWindow({
      bucket: "day",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-10T00:00:00.000Z",
      tz: "America/New_York",
    });
    expect(w.tz).toBe("America/New_York");
  });

  test("empty tz string falls back to UTC", () => {
    const w = resolveWindow({
      bucket: "day",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-10T00:00:00.000Z",
      tz: "",
    });
    expect(w.tz).toBe("UTC");
  });

  test("accepts an Etc/* offset zone", () => {
    const w = resolveWindow({
      bucket: "day",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-10T00:00:00.000Z",
      tz: "Etc/GMT+5",
    });
    expect(w.tz).toBe("Etc/GMT+5");
  });

  test("window exactly at cap (minute) is accepted", () => {
    const toMs = new Date(T0).getTime();
    const fromMs = toMs - WINDOW_CAP_MS.minute;
    expect(() =>
      resolveWindow({ bucket: "minute", from: new Date(fromMs).toISOString(), to: T0 }),
    ).not.toThrow();
  });

  test("window exactly at cap (day) is accepted", () => {
    const toMs = new Date(T0).getTime();
    const fromMs = toMs - WINDOW_CAP_MS.day;
    expect(() =>
      resolveWindow({ bucket: "day", from: new Date(fromMs).toISOString(), to: T0 }),
    ).not.toThrow();
  });
});

describe("resolveWindow — bucket_window_too_large", () => {
  const cases: Array<[string, number]> = [
    ["minute", WINDOW_CAP_MS.minute + 1],
    ["hour", WINDOW_CAP_MS.hour + 1],
    ["day", WINDOW_CAP_MS.day + 1],
    ["month", WINDOW_CAP_MS.month + 1],
    ["year", WINDOW_CAP_MS.year + 1],
  ];

  for (const [bucket, overCapMs] of cases) {
    test(`${bucket} bucket rejects window ${overCapMs}ms wide with reason=bucket_window_too_large`, () => {
      const toMs = new Date(T0).getTime();
      const from = msAgo(toMs, overCapMs);
      let threw: unknown;
      try {
        resolveWindow({ bucket, from, to: T0 });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
      expect(detailsReason(threw)).toBe("bucket_window_too_large");
    });
  }
});

describe("resolveWindow — to <= from rejected", () => {
  test("to === from returns window_empty", () => {
    let threw: unknown;
    try {
      resolveWindow({ bucket: "hour", from: T0, to: T0 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("window_empty");
  });

  test("to < from returns window_empty", () => {
    const toMs = new Date(T0).getTime();
    let threw: unknown;
    try {
      resolveWindow({
        bucket: "hour",
        from: T0,
        to: new Date(toMs - 1000).toISOString(),
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("window_empty");
  });
});

describe("resolveWindow — invalid inputs", () => {
  test("invalid bucket name throws bucket_invalid", () => {
    let threw: unknown;
    try {
      resolveWindow({ bucket: "week", from: T0 });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("bucket_invalid");
  });

  test("unparseable from throws from_invalid", () => {
    let threw: unknown;
    try {
      resolveWindow({ bucket: "hour", from: "not-a-date" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("from_invalid");
  });

  test("unparseable to throws to_invalid", () => {
    let threw: unknown;
    try {
      resolveWindow({ bucket: "hour", from: T0, to: "not-a-date" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("to_invalid");
  });

  test("unknown timezone throws tz_invalid (not a 500 from Postgres)", () => {
    let threw: unknown;
    try {
      resolveWindow({ bucket: "day", from: "2026-01-01T00:00:00.000Z", to: T0, tz: "Bogus/Zone" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("tz_invalid");
  });

  test("a quote-injection tz attempt is rejected as tz_invalid", () => {
    let threw: unknown;
    try {
      resolveWindow({
        bucket: "day",
        from: "2026-01-01T00:00:00.000Z",
        to: T0,
        tz: "UTC') --",
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(detailsReason(threw)).toBe("tz_invalid");
  });
});

test("msLater helper sanity", () => {
  const now = new Date(T0).getTime();
  const later = new Date(msLater(now, 1000)).getTime();
  expect(later - now).toBe(1000);
});
