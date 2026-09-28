import { describe, expect, test } from "bun:test";
import { formatDurationMs, usageRows } from "@/pages/usage-model";

describe("cockpit usage presentation", () => {
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
});
