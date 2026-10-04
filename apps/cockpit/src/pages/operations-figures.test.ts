// The operations bar on the Übersicht: six figures, each a link into the
// list or page that counts the same thing over the same window (§10.1).

import { describe, expect, test } from "bun:test";
import { auditFilterFromUrl } from "@/pages/audit-model";
import { connectorHealthFilterFromUrl } from "@/pages/connectors-model";
import {
  DECIDED_REPAIR_ACTIONS,
  executionStatsEndpoint,
  llmStatsEndpoint,
  monthSpendEndpoint,
  type OperatingCounts,
  type OperatingFigure,
  operatingCounts,
  operatingFigures,
  operatingFiguresEndpoint,
  usageWindowFromUrl,
  windowBounds,
  windowBucket,
  windowSpend,
} from "@/pages/operations-figures";
import { filterFromUrl } from "@/pages/runs-model";
import { budgetSummary, windowCost } from "@/pages/usage-model";

describe("the engine's operating figures", () => {
  const NOW = new Date("2026-08-10T12:00:00.000Z");

  test("are asked over the window's two fixed instants", () => {
    const endpoint = operatingFiguresEndpoint(windowBounds("30d", NOW));
    expect(endpoint.startsWith("/v1/stats/operating-figures?")).toBe(true);
    const query = new URLSearchParams(endpoint.slice(endpoint.indexOf("?")));
    expect([query.get("from"), query.get("to")]).toEqual([
      "2026-07-11T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
    ]);
  });

  test("reads the counts and the engine's own percentages, not a second rounding", () => {
    expect(
      operatingCounts({
        schema_version: "operating-figures.v1",
        window: { from: "a", to: "b" },
        // 36 of 40 would be 90 here; the engine's number is the one shown.
        runs: { total: 40, succeeded: 36, failed: 4, success_rate_percent: 91 },
        connectors: { enabled: 8, not_ok: 2, healthy_percent: 75 },
        repairs: { decided: 4, applied: 3, applied_percent: 75 },
      }),
    ).toEqual({
      runs: { total: 40, failed: 4, successRatePercent: 91 },
      connectors: { enabled: 8, notOk: 2, healthyPercent: 75 },
      repairs: { decided: 4, appliedPercent: 75 },
    });
  });

  test("an answer that is not the figures is no counts at all", () => {
    expect(operatingCounts(null)).toBeNull();
    expect(operatingCounts({ totals: { executions: { count: 40 } } })).toBeNull();
    expect(
      operatingCounts({
        runs: { total: 1, failed: 0 },
        connectors: { enabled: 1 },
        repairs: { decided: 0 },
      }),
    ).toBeNull();
  });
});

describe("the operations figures", () => {
  const NOW = new Date("2026-08-10T12:00:00.000Z");
  const WEEK = windowBounds("7d", NOW);
  const all = { runs: true, connectors: true, audit: true, usage: true, budgetSetting: true };
  const answered = <T>(value: T) => ({ state: "answered" as const, value });
  const query = (href: string | null) => (href ? href.slice(href.indexOf("?")) : "");
  const stats = (endpoint: string) => new URLSearchParams(endpoint.slice(endpoint.indexOf("?")));
  const priced = {
    calls: 120,
    cost: { amount: 87.22, currency: "USD", unpricedModels: [], unpricedCalls: 0 },
  };
  const month = budgetSummary({
    tokens_month: 40_500_000,
    monthly_budget_tokens: 150_000_000,
    remaining_monthly_budget_tokens: 109_500_000,
  });
  // The calendar month's money — what the budget figure leads with.
  const monthPriced = {
    calls: 900,
    cost: { amount: 135.8, currency: "USD", unpricedModels: [], unpricedCalls: 0 },
  };
  const counts = (over: Partial<OperatingCounts> = {}) =>
    answered<OperatingCounts | null>({
      runs: { total: 40, failed: 2, successRatePercent: 95 },
      connectors: { enabled: 8, notOk: 2, healthyPercent: 75 },
      repairs: { decided: 4, appliedPercent: 75 },
      ...over,
    });
  const figuresOf = (overrides: Partial<Parameters<typeof operatingFigures>[0]> = {}) =>
    operatingFigures({
      bounds: WEEK,
      counts: counts(),
      connectorsPermitted: true,
      spend: answered(priced),
      budget: answered(month),
      monthSpend: answered(monthPriced),
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
    // Runs, connectors and repairs are counted over the very same bounds.
    const figures = stats(operatingFiguresEndpoint(WEEK));
    expect([figures.get("from"), figures.get("to")]).toEqual([WEEK.from, WEEK.to]);
  });

  test("every link opens the list the number counted: same window, same filter", () => {
    const figures = figuresOf();
    expect(figures.map((figure) => [figure.id, value(figure)?.value])).toEqual([
      ["runs", 40],
      ["successRate", 95],
      ["connectorHealth", 75],
      ["repairRate", 75],
      ["cost", 87.22],
      ["budget", 135.8],
    ]);
    const [runs, rate, connectors, repairs, cost, budget] = figures.map(value);
    // Cost: Nutzung over the very window the amount was read over.
    expect(usageWindowFromUrl(query(cost?.href ?? null))).toBe("7d");
    expect(cost?.href).toBe("/usage?window=7d");
    // Budget: the month, on Nutzung — the window does not narrow a month.
    expect(budget?.href).toBe("/usage");
    // Runs: the runs that started in the window — the stats query's bounds.
    const window = { startedFrom: WEEK.from, startedTo: WEEK.to };
    expect(filterFromUrl(query(runs?.href ?? null))).toMatchObject({ status: "all", ...window });
    const statsQuery = stats(operatingFiguresEndpoint(WEEK));
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
    expect(figures.map((figure) => figure.basis)).toEqual([
      "window",
      "window",
      "now",
      "window",
      "window",
      "month",
    ]);
  });

  test("a link that would open an empty list is no link", () => {
    const [, rate, connectors] = figuresOf({
      counts: counts({
        runs: { total: 12, failed: 0, successRatePercent: 100 },
        connectors: { enabled: 5, notOk: 0, healthyPercent: 100 },
      }),
    }).map(value);
    expect(rate?.value).toBe(100);
    expect(rate?.href).toBeNull();
    expect(connectors?.value).toBe(100);
    expect(connectors?.href).toBeNull();
  });

  test("a figure with nothing to say says so — never a tile reading 0", () => {
    const figures = figuresOf({
      counts: counts({
        runs: { total: 0, failed: 0, successRatePercent: null },
        connectors: { enabled: 0, notOk: 0, healthyPercent: null },
        repairs: { decided: 0, appliedPercent: null },
      }),
      spend: answered({ calls: 0, cost: windowCost({ cost: { amount: 0, currency: "USD" } }) }),
    });
    // Always six: the bar keeps its shape, and each empty slot says why.
    expect(figures.map((figure) => [figure.id, figure.state])).toEqual([
      ["runs", "none"],
      ["successRate", "none"],
      ["connectorHealth", "none"],
      ["repairRate", "none"],
      ["cost", "none"],
      ["budget", "value"],
    ]);
    // A rate of nought over real runs is a fact, and it stays.
    expect(
      figuresOf({
        counts: counts({
          runs: { total: 3, failed: 3, successRatePercent: 0 },
          repairs: { decided: 0, appliedPercent: null },
        }),
        connectorsPermitted: false,
      }).map((figure) => [figure.id, figure.state, value(figure)?.value]),
    ).toEqual([
      ["runs", "value", 3],
      ["successRate", "value", 0],
      ["connectorHealth", "not_permitted", undefined],
      ["repairRate", "none", undefined],
      ["cost", "value", 87.22],
      ["budget", "value", 135.8],
    ]);
  });

  test("a read that failed is said as unreadable, never as nothing to report", () => {
    const figures = figuresOf({
      counts: { state: "failed" },
      spend: { state: "failed" },
      budget: { state: "failed" },
    });
    expect(figures.map((figure) => [figure.id, figure.state])).toEqual([
      ["runs", "unreadable"],
      ["successRate", "unreadable"],
      ["connectorHealth", "unreadable"],
      ["repairRate", "unreadable"],
      ["cost", "unreadable"],
      ["budget", "unreadable"],
    ]);
  });

  test("the cost is the window's money, read over the figures' own bounds", () => {
    const endpoint = stats(llmStatsEndpoint(WEEK));
    expect([endpoint.get("from"), endpoint.get("to")]).toEqual([WEEK.from, WEEK.to]);
    expect(endpoint.get("group_by")).toBeNull();
    // Nutzung asks the same window, with its breakdown axis.
    expect(stats(llmStatsEndpoint(WEEK, "model")).get("group_by")).toBe("model");
    expect(
      windowSpend({
        totals: { calls: { total: 12, by_result: {} } },
        cost: { amount: 3.5, currency: "USD", unpriced_models: [], unpriced_calls: 0 },
      }),
    ).toEqual({
      calls: 12,
      cost: { amount: 3.5, currency: "USD", unpricedModels: [], unpricedCalls: 0 },
    });
  });

  test("a partly priced window is a floor that carries what it leaves out", () => {
    const cost = value(
      figuresOf({
        spend: answered({
          calls: 120,
          cost: {
            amount: 412.87,
            currency: "EUR",
            unpricedModels: ["some-new-model"],
            unpricedCalls: 47,
          },
        }),
      })[4],
    );
    expect(cost?.value).toBe(412.87);
    expect(cost?.money).toEqual({ currency: "EUR", unpricedCalls: 47 });
  });

  test("calls without any price are said in words, never as an amount of nought", () => {
    const spend = windowSpend({
      totals: { calls: { total: 30, by_result: {} } },
      cost: { amount: 0, currency: "USD", unpriced_models: ["x"], unpriced_calls: 30 },
    });
    expect(spend.cost).toBeNull();
    const cost = figuresOf({ spend: answered(spend) })[4];
    expect(cost?.state).toBe("unpriced");
    expect(cost && "href" in cost ? cost.href : null).toBe("/usage?window=7d");
  });

  test("the month's usage is its money, with its whole share of the cap and the engine's word", () => {
    const at = (used: number) =>
      value(
        figuresOf({
          budget: answered(
            budgetSummary({
              tokens_month: used,
              monthly_budget_tokens: 1000,
              remaining_monthly_budget_tokens: Math.max(1000 - used, 0),
            }),
          ),
        })[5],
      );
    expect([at(270)?.value, at(270)?.money]).toEqual([
      135.8,
      { currency: "USD", unpricedCalls: 0 },
    ]);
    expect([at(270)?.budget?.percent, at(270)?.budget?.pressure]).toEqual([27, "ample"]);
    expect([at(750)?.budget?.percent, at(750)?.budget?.pressure]).toEqual([75, "tightening"]);
    // 89.6 % reads "89 %" beside "Wird knapp" — the engine's exact share.
    expect([at(896)?.budget?.percent, at(896)?.budget?.pressure]).toEqual([89, "tightening"]);
    expect(at(270)?.budget).toMatchObject({ budgetTokens: 1000, remainingTokens: 730 });
    expect(at(270)?.basis).toBe("month");
  });

  test("a month without a priced amount falls back to its share of the cap", () => {
    for (const monthSpend of [
      answered({ calls: 30, cost: null }),
      answered({ calls: 0, cost: null }),
    ]) {
      const figure = value(figuresOf({ monthSpend })[5]);
      expect([figure?.value, figure?.money, figure?.budget?.percent]).toEqual([27, undefined, 27]);
    }
  });

  test("the month's money and its share are both read — either failing makes it unreadable", () => {
    expect(figuresOf({ monthSpend: { state: "failed" } })[5]?.state).toBe("unreadable");
    expect(figuresOf({ budget: { state: "failed" } })[5]?.state).toBe("unreadable");
  });

  test("no cap still shows the month's money, and says there is no cap", () => {
    const uncapped = answered(budgetSummary({ tokens_month: 5_000, monthly_budget_tokens: null }));
    const figure = value(figuresOf({ budget: uncapped })[5]);
    expect([figure?.value, figure?.uncapped, figure?.budget, figure?.href]).toEqual([
      135.8,
      true,
      undefined,
      "/usage",
    ]);
  });

  test("no cap and no amount is 'no budget' — no percentage — and links the setting only for who may set it", () => {
    const uncapped = answered(budgetSummary({ tokens_month: 5_000, monthly_budget_tokens: null }));
    const unpriced = answered({ calls: 30, cost: null });
    const figure = figuresOf({ budget: uncapped, monthSpend: unpriced })[5];
    expect(figure?.state).toBe("uncapped");
    expect(figure && "href" in figure ? figure.href : null).toBe(
      "/settings?leaf=tokens.monthly_budget",
    );
    const readOnly = figuresOf({
      budget: uncapped,
      monthSpend: unpriced,
      canOpen: { ...all, budgetSetting: false },
    })[5];
    expect(readOnly && "href" in readOnly ? readOnly.href : "missing").toBeNull();
  });

  test("the month's money is asked from the first of the UTC month to now, in days", () => {
    const endpoint = monthSpendEndpoint(new Date("2026-10-04T09:30:00.000Z"));
    const query = stats(endpoint);
    expect(endpoint.startsWith("/v1/stats/llm?")).toBe(true);
    expect([query.get("bucket"), query.get("from"), query.get("to")]).toEqual([
      "day",
      "2026-10-01T00:00:00.000Z",
      "2026-10-04T09:30:00.000Z",
    ]);
    expect(query.get("group_by")).toBeNull();
  });

  test("a value the reader may not open is shown without a link", () => {
    const figures = figuresOf({
      canOpen: { runs: false, connectors: false, audit: false, usage: false, budgetSetting: false },
    });
    expect(figures.map((figure) => value(figure)?.href)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  test("an answer that was not the figures is unreadable, never nothing to report", () => {
    expect(
      figuresOf({ counts: answered(null) })
        .slice(0, 4)
        .map((figure) => [figure.id, figure.state]),
    ).toEqual([
      ["runs", "unreadable"],
      ["successRate", "unreadable"],
      ["connectorHealth", "unreadable"],
      ["repairRate", "unreadable"],
    ]);
  });

  test("a reader who may not read connectors is told so, whatever the engine counted", () => {
    const connector = figuresOf({ connectorsPermitted: false })[2];
    expect([connector?.id, connector?.state]).toEqual(["connectorHealth", "not_permitted"]);
  });
});
