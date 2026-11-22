import { describe, expect, test } from "bun:test";
import { BUCKETS, buildQuery, resolveTime, ValidationError, WINDOW_CAP_MS } from "./stats.ts";

const NOW_MS = new Date("2026-01-15T12:00:00.000Z").getTime();

describe("resolveTime — absolute ISO-8601", () => {
  test("parses a valid ISO-8601 string", () => {
    const d = resolveTime("2026-01-10T00:00:00.000Z", NOW_MS);
    expect(d.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  test("throws ValidationError for an unparseable string", () => {
    expect(() => resolveTime("not-a-date", NOW_MS)).toThrow(ValidationError);
  });

  test("throws ValidationError for a purely relative form without 'now' prefix (startOfWeek)", () => {
    expect(() => resolveTime("startOfWeek", NOW_MS)).toThrow(ValidationError);
  });
});

describe("resolveTime — relative forms", () => {
  test("'now' resolves to current ms", () => {
    const d = resolveTime("now", NOW_MS);
    expect(d.getTime()).toBe(NOW_MS);
  });

  test("'startOfMonth' resolves to UTC first of the month", () => {
    const d = resolveTime("startOfMonth", NOW_MS);
    expect(d.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("'now-24h' is exactly 24h before NOW_MS", () => {
    const d = resolveTime("now-24h", NOW_MS);
    expect(NOW_MS - d.getTime()).toBe(24 * 3_600_000);
  });

  test("'now-7d' is exactly 7 days before NOW_MS", () => {
    const d = resolveTime("now-7d", NOW_MS);
    expect(NOW_MS - d.getTime()).toBe(7 * 86_400_000);
  });

  test("'now-30m' is exactly 30 minutes before NOW_MS", () => {
    const d = resolveTime("now-30m", NOW_MS);
    expect(NOW_MS - d.getTime()).toBe(30 * 60_000);
  });

  test("'now-2w' is exactly 14 days before NOW_MS", () => {
    const d = resolveTime("now-2w", NOW_MS);
    expect(NOW_MS - d.getTime()).toBe(14 * 86_400_000);
  });

  test("leading/trailing spaces are trimmed", () => {
    const d = resolveTime("  now  ", NOW_MS);
    expect(d.getTime()).toBe(NOW_MS);
  });
});

describe("buildQuery — zero-config defaults applied correctly", () => {
  test("executions default: bucket=hour, from=now-24h", () => {
    const q = buildQuery({}, { bucket: "hour", from: "now-24h" }, {});
    expect(q.bucket).toBe("hour");
    const fromMs = new Date(q.from).getTime();
    const toMs = new Date(q.to!).getTime();
    expect(toMs - fromMs).toBeCloseTo(24 * 3_600_000, -3);
  });

  test("llm default: bucket=day, from=startOfMonth", () => {
    const q = buildQuery({}, { bucket: "day", from: "startOfMonth" }, {});
    expect(q.bucket).toBe("day");
    const fromDate = new Date(q.from);
    expect(fromDate.getUTCDate()).toBe(1);
    expect(fromDate.getUTCHours()).toBe(0);
    expect(fromDate.getUTCMinutes()).toBe(0);
  });

  test("explicit args override defaults", () => {
    const q = buildQuery(
      { bucket: "day", from: "2026-01-01T00:00:00.000Z", to: "2026-01-10T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      {},
    );
    expect(q.bucket).toBe("day");
    expect(q.from).toBe("2026-01-01T00:00:00.000Z");
    expect(q.to).toBe("2026-01-10T00:00:00.000Z");
  });
});

describe("buildQuery — extra fields are forwarded", () => {
  test("connector_id is forwarded when set", () => {
    const q = buildQuery(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      { connector_id: "abc-123" },
    );
    expect(q.connector_id).toBe("abc-123");
  });

  test("undefined extra fields are omitted from the query", () => {
    const q = buildQuery(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      { connector_id: undefined },
    );
    expect("connector_id" in q).toBe(false);
  });

  test("empty string extra fields are omitted from the query", () => {
    const q = buildQuery(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      { connector_id: "" },
    );
    expect("connector_id" in q).toBe(false);
  });

  test("usage traffic class and response mode are forwarded", () => {
    const q = buildQuery(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      { traffic_class: "synthetic", response_mode: "sse" },
    );
    expect(q.traffic_class).toBe("synthetic");
    expect(q.response_mode).toBe("sse");
  });
});

describe("buildQuery — invalid bucket rejected", () => {
  test("throws ValidationError for unrecognised bucket", () => {
    expect(() =>
      buildQuery(
        { bucket: "week", from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
        { bucket: "hour", from: "now-24h" },
        {},
      ),
    ).toThrow(ValidationError);
  });

  test("all valid bucket names are accepted", () => {
    for (const bucket of BUCKETS) {
      expect(() =>
        buildQuery(
          { bucket, from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
          { bucket, from: "now-24h" },
          {},
        ),
      ).not.toThrow();
    }
  });
});

describe("buildQuery — to <= from rejected", () => {
  test("to equal to from throws ValidationError", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    expect(() => buildQuery({ from: ts, to: ts }, { bucket: "hour", from: "now-24h" }, {})).toThrow(
      ValidationError,
    );
  });

  test("to before from throws ValidationError", () => {
    expect(() =>
      buildQuery(
        { from: "2026-01-10T00:00:00.000Z", to: "2026-01-09T00:00:00.000Z" },
        { bucket: "hour", from: "now-24h" },
        {},
      ),
    ).toThrow(ValidationError);
  });
});

describe("buildQuery — window cap enforcement mirrors server caps", () => {
  const cases: Array<[string, number]> = [
    ["minute", WINDOW_CAP_MS.minute + 1],
    ["hour", WINDOW_CAP_MS.hour + 1],
    ["day", WINDOW_CAP_MS.day + 1],
    ["month", WINDOW_CAP_MS.month + 1],
    ["year", WINDOW_CAP_MS.year + 1],
  ];

  const BASE_TO = "2026-01-15T12:00:00.000Z";
  const BASE_TO_MS = new Date(BASE_TO).getTime();

  for (const [bucket, overCapMs] of cases) {
    test(`${bucket}: window ${overCapMs}ms wide throws ValidationError with cap hint`, () => {
      const from = new Date(BASE_TO_MS - overCapMs).toISOString();
      let threw: unknown;
      try {
        buildQuery(
          { bucket, from, to: BASE_TO },
          { bucket: bucket as "hour", from: "now-24h" },
          {},
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
      expect(threw instanceof ValidationError).toBe(true);
      expect((threw as ValidationError).message).toContain(bucket);
    });
  }
});

describe("buildQuery — unparseable --from", () => {
  test("relative form 'now-24h' resolves without throwing", () => {
    expect(() =>
      buildQuery({ from: "now-24h" }, { bucket: "hour", from: "now-24h" }, {}),
    ).not.toThrow();
  });

  test("'startOfMonth' as --from resolves without throwing", () => {
    expect(() =>
      buildQuery({ from: "startOfMonth" }, { bucket: "day", from: "startOfMonth" }, {}),
    ).not.toThrow();
  });

  test("relative form 'yesterday' (not a valid relative expr) throws ValidationError", () => {
    expect(() =>
      buildQuery({ from: "yesterday" }, { bucket: "hour", from: "now-24h" }, {}),
    ).toThrow(ValidationError);
  });
});

describe("buildQuery — --json output shape is stable", () => {
  test("returned query has the three required envelope keys", () => {
    const q = buildQuery(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { bucket: "hour", from: "now-24h" },
      {},
    );
    expect(typeof q.bucket).toBe("string");
    expect(typeof q.from).toBe("string");
    expect(typeof q.to).toBe("string");
    expect(Number.isNaN(new Date(q.from).getTime())).toBe(false);
    expect(Number.isNaN(new Date(q.to!).getTime())).toBe(false);
  });
});
