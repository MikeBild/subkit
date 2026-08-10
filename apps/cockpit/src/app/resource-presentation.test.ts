import { describe, expect, test } from "bun:test";
import { presentationRows, usageStatsEndpoint } from "@/pages/resource";

describe("cockpit resource presentation", () => {
  test("supplies the required usage window", () => {
    const endpoint = usageStatsEndpoint(new Date("2026-08-10T12:00:00.000Z"));
    expect(endpoint).toContain("bucket=day");
    expect(endpoint).toContain("from=2026-07-11T12%3A00%3A00.000Z");
  });

  test("turns usage buckets into readable rows", () => {
    expect(
      presentationRows("usage", [
        {
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
        },
      ]),
    ).toEqual([
      {
        date: "2026-08-10T00:00:00.000Z",
        executions: 4,
        average_duration_ms: 1200,
        p95_duration_ms: 2400,
      },
    ]);
  });

  test("exposes setting provenance without dumping nested metadata", () => {
    expect(
      presentationRows("settings", [
        {
          items: [
            {
              path: "execution.timeout_ms",
              value: 5000,
              meta: { source: "default", scope: "tenant", requiresRestart: false },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        path: "execution.timeout_ms",
        value: 5000,
        source: "default",
        scope: "tenant",
        requires_restart: false,
      },
    ]);
  });
});
