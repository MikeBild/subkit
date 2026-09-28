import { describe, expect, test } from "bun:test";
import { formatDurationMs, usageRows, usageStatsEndpoint, usageTotals } from "@/pages/usage-model";

describe("cockpit usage presentation", () => {
  test("supplies the required usage window", () => {
    const endpoint = usageStatsEndpoint("30d", new Date("2026-08-10T12:00:00.000Z"));
    expect(endpoint).toContain("bucket=day");
    expect(endpoint).toContain("from=2026-07-11T12%3A00%3A00.000Z");
  });

  test("turns usage buckets into readable rows", () => {
    expect(
      usageRows({
        groups: [
          {
            buckets: [
              {
                ts: "2026-08-10T00:00:00.000Z",
                executions: 4,
                duration_ms: { avg: 1200, p95: 2400 },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        date: "2026-08-10T00:00:00.000Z",
        executions: 4,
        average_duration_ms: 1200,
        p95_duration_ms: 2400,
      },
    ]);
  });

  test("keeps an unmeasured duration missing rather than calling it zero", () => {
    const [row] = usageRows({
      groups: [{ buckets: [{ ts: "2026-08-10T00:00:00.000Z", executions: 0 }] }],
    });
    expect(row?.average_duration_ms).toBeNull();
    expect(formatDurationMs(row?.average_duration_ms ?? null)).toBe("—");
  });

  test("ignores an envelope that carries no groups", () => {
    expect(usageRows(null)).toEqual([]);
    expect(usageRows({})).toEqual([]);
  });

  test("reads the headline totals and the success rate they imply", () => {
    expect(
      usageTotals({
        totals: {
          executions: { count: 40, by_status: { completed: 36, failed: 4 } },
          duration_ms: { avg: 1110, p95: 2300 },
        },
      }),
    ).toEqual({
      executions: 40,
      averageDurationMs: 1110,
      p95DurationMs: 2300,
      successRatePercent: 90,
    });
  });

  test("reports no success rate when nothing ran", () => {
    expect(usageTotals({ totals: { executions: { count: 0, by_status: {} } } })).toEqual({
      executions: 0,
      averageDurationMs: null,
      p95DurationMs: null,
      successRatePercent: null,
    });
  });
});
