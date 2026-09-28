// The operations bar on the Übersicht: four figures, each a link into the
// list that counts the same rows over the same window (§10.1).

import { describe, expect, test } from "bun:test";
import { auditFilterFromUrl } from "@/pages/audit-model";
import { connectorHealthFilterFromUrl } from "@/pages/connectors-model";
import {
  CONNECTORS_ENABLED_ENDPOINT,
  CONNECTORS_NOT_OK_ENDPOINT,
  DECIDED_REPAIR_ACTIONS,
  executionStatsEndpoint,
  listTotal,
  type OperatingFigure,
  operatingFigures,
  repairStatsEndpoint,
  repairTotals,
  runTotals,
  windowBounds,
  windowBucket,
} from "@/pages/operations-figures";
import { filterFromUrl } from "@/pages/runs-model";

describe("the window's run totals", () => {
  test("supplies the required window", () => {
    const endpoint = executionStatsEndpoint(
      windowBounds("30d", new Date("2026-08-10T12:00:00.000Z")),
    );
    expect(endpoint).toContain("bucket=day");
    expect(endpoint).toContain("from=2026-07-11T12%3A00%3A00.000Z");
  });

  test("reads the run count and the success rate it implies", () => {
    expect(
      runTotals({
        totals: {
          executions: { count: 40, by_status: { completed: 36, failed: 4 } },
          duration_ms: { avg: 1110, p95: 2300 },
        },
      }),
    ).toEqual({ executions: 40, successRatePercent: 90, failedRuns: 4 });
  });

  test("reports no success rate when nothing ran", () => {
    expect(runTotals({ totals: { executions: { count: 0, by_status: {} } } })).toEqual({
      executions: 0,
      successRatePercent: null,
      failedRuns: 0,
    });
  });
});

describe("the operations figures", () => {
  const NOW = new Date("2026-08-10T12:00:00.000Z");
  const WEEK = windowBounds("7d", NOW);
  const all = { runs: true, connectors: true, audit: true };
  const answered = <T>(value: T) => ({ state: "answered" as const, value });
  const query = (href: string | null) => (href ? href.slice(href.indexOf("?")) : "");
  const stats = (endpoint: string) => new URLSearchParams(endpoint.slice(endpoint.indexOf("?")));
  const figuresOf = (overrides: Partial<Parameters<typeof operatingFigures>[0]> = {}) =>
    operatingFigures({
      bounds: WEEK,
      totals: answered({ executions: 40, failedRuns: 2, successRatePercent: 95 }),
      connectors: answered({ enabled: 8, notOk: 2 }),
      repairs: answered({ decided: 4, applied: 3 }),
      canOpen: all,
      ...overrides,
    });
  const value = (figure: OperatingFigure | undefined) =>
    figure?.state === "value" ? figure : undefined;

  test("each window is two fixed instants, asked in a bucket the engine's caps allow", () => {
    expect(windowBounds("24h", NOW)).toEqual({
      window: "24h",
      from: "2026-08-09T12:00:00.000Z",
      to: "2026-08-10T12:00:00.000Z",
    });
    expect(executionStatsEndpoint(windowBounds("24h", NOW))).toBe(
      "/v1/stats/executions?bucket=hour&from=2026-08-09T12%3A00%3A00.000Z&to=2026-08-10T12%3A00%3A00.000Z",
    );
    expect(stats(executionStatsEndpoint(WEEK)).get("bucket")).toBe("day");
    expect(stats(executionStatsEndpoint(WEEK)).get("from")).toBe("2026-08-03T12:00:00.000Z");
    expect(windowBucket("24h")).toBe("hour");
    expect(windowBucket("30d")).toBe("day");
    // The repair rate is read over the very same bounds as the runs.
    const repairs = stats(repairStatsEndpoint(WEEK));
    expect(repairs.get("class")).toBe("self_healing");
    expect([repairs.get("from"), repairs.get("to")]).toEqual([WEEK.from, WEEK.to]);
  });

  test("every link opens the list the number counted: same window, same filter", () => {
    const figures = figuresOf();
    expect(figures.map((figure) => [figure.id, value(figure)?.value])).toEqual([
      ["runs", 40],
      ["successRate", 95],
      ["connectorHealth", 75],
      ["repairRate", 75],
    ]);
    const [runs, rate, connectors, repairs] = figures.map(value);
    // Runs: the runs that started in the window — the stats query's bounds.
    const window = { startedFrom: WEEK.from, startedTo: WEEK.to };
    expect(filterFromUrl(query(runs?.href ?? null))).toMatchObject({ status: "all", ...window });
    const statsQuery = stats(executionStatsEndpoint(WEEK));
    expect([statsQuery.get("from"), statsQuery.get("to")]).toEqual([
      window.startedFrom,
      window.startedTo,
    ]);
    // Success rate: the failed runs of that same window.
    expect(filterFromUrl(query(rate?.href ?? null))).toMatchObject({ status: "failed", ...window });
    // Connector health: the connectors unwell now.
    expect(connectorHealthFilterFromUrl(query(connectors?.href ?? null))).toBe("not_ok");
    // Repair rate: the decided repairs of the window, by exactly the counted verbs.
    const audit = auditFilterFromUrl(query(repairs?.href ?? null));
    expect(audit).toMatchObject({ scope: "all", tsFrom: WEEK.from, tsTo: WEEK.to });
    expect(audit.actions).toEqual([...DECIDED_REPAIR_ACTIONS]);
    expect(figures.map((figure) => figure.current)).toEqual([false, false, true, false]);
  });

  test("a link that would open an empty list is no link", () => {
    const [, rate, connectors] = figuresOf({
      totals: answered({ executions: 12, failedRuns: 0, successRatePercent: 100 }),
      connectors: answered({ enabled: 5, notOk: 0 }),
    }).map(value);
    expect(rate?.value).toBe(100);
    expect(rate?.href).toBeNull();
    expect(connectors?.value).toBe(100);
    expect(connectors?.href).toBeNull();
  });

  test("a figure with nothing to say says so — never a tile reading 0", () => {
    const figures = figuresOf({
      totals: answered({ executions: 0, failedRuns: 0, successRatePercent: null }),
      connectors: answered({ enabled: 0, notOk: 0 }),
      repairs: answered({ decided: 0, applied: 0 }),
    });
    // Always four: the bar keeps its shape, and each empty slot says why.
    expect(figures.map((figure) => [figure.id, figure.state])).toEqual([
      ["runs", "none"],
      ["successRate", "none"],
      ["connectorHealth", "none"],
      ["repairRate", "none"],
    ]);
    // A rate of nought over real runs is a fact, and it stays.
    expect(
      figuresOf({
        totals: answered({ executions: 3, failedRuns: 3, successRatePercent: 0 }),
        connectors: null,
        repairs: answered(null),
      }).map((figure) => [figure.id, figure.state, value(figure)?.value]),
    ).toEqual([
      ["runs", "value", 3],
      ["successRate", "value", 0],
      ["connectorHealth", "not_permitted", undefined],
      ["repairRate", "none", undefined],
    ]);
  });

  test("a read that failed is said as unreadable, never as nothing to report", () => {
    const figures = figuresOf({
      totals: { state: "failed" },
      connectors: { state: "failed" },
      repairs: { state: "failed" },
    });
    expect(figures.map((figure) => [figure.id, figure.state])).toEqual([
      ["runs", "unreadable"],
      ["successRate", "unreadable"],
      ["connectorHealth", "unreadable"],
      ["repairRate", "unreadable"],
    ]);
  });

  test("a value the reader may not open is shown without a link", () => {
    const figures = figuresOf({ canOpen: { runs: false, connectors: false, audit: false } });
    expect(figures.map((figure) => value(figure)?.href)).toEqual([null, null, null, null]);
  });

  test("the repair rate counts exactly the verbs its link opens", () => {
    const group = (action: string, total: number) => ({
      key: { action },
      totals: { calls: { total, by_outcome: { success: total, denied: 0, error: 0 } } },
    });
    expect(
      repairTotals({
        groups: [
          group("patch_candidate.proposed", 9),
          group("patch_candidate.approved", 2),
          group("patch_candidate.auto_applied", 1),
          group("patch_candidate.rejected", 3),
        ],
      }),
    ).toEqual({ decided: 6, applied: 3 });
    expect(repairTotals({ items: [] })).toBeNull();
    expect(repairTotals(null)).toBeNull();
  });

  test("connector health is the engine's two totals, the unwell one being the linked list", () => {
    expect(CONNECTORS_NOT_OK_ENDPOINT).toContain("health=not_ok");
    expect(CONNECTORS_ENABLED_ENDPOINT).toContain("enabled=true");
    expect(listTotal({ items: [], total: 7 })).toBe(7);
    expect(listTotal({ items: [] })).toBeNull();
  });
});
