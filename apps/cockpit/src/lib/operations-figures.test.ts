import { describe, expect, test } from "bun:test";
import { resolveApiPath } from "@/api/call";
import { attentionFromSearch } from "@/features/connectors";
import { auditFilterFromUrl } from "@/lib/audit-model";
import {
  DECIDED_REPAIR_ACTIONS,
  llmStatsEndpoint,
  llmStatsQuery,
  type OperatingCounts,
  type OperatingFigure,
  operatingCounts,
  operatingFigures,
  operatingFiguresQuery,
  promptCacheFlows,
  promptCacheShare,
  REPAIR_REQUIRED_QUERY,
  repairRequiredCount,
  usageWindowFromUrl,
  usageWindowSearch,
  windowBounds,
  windowBucket,
  windowSpend,
  windowStatsQuery,
} from "@/lib/operations-figures";
import { STATS_WINDOWS } from "@/lib/stats-window";
import { budgetSummary, windowCost } from "@/lib/usage-model";
import { filterFromUrl } from "@/pages/runs-model";

describe("usage window URL round trips", () => {
  test("every selectable period survives navigation with unrelated query parameters", () => {
    for (const period of STATS_WINDOWS) {
      for (const initial of [
        "",
        "?window=unknown",
        "?window=lastMonth&filter=one&filter=two&future=kept",
      ]) {
        const search = usageWindowSearch(initial, period);
        expect(usageWindowFromUrl(search)).toBe(period);
        const before = new URLSearchParams(initial);
        const after = new URLSearchParams(search);
        expect(after.getAll("filter")).toEqual(before.getAll("filter"));
        expect(after.get("future")).toBe(before.get("future"));
        expect(after.has("window")).toBe(period !== "thisWeek");
      }
    }
  });

  test("missing and unrecognized periods use this week and canonicalize cleanly", () => {
    expect(usageWindowFromUrl("")).toBe("thisWeek");
    expect(usageWindowFromUrl("?window=7d")).toBe("thisWeek");
    expect(usageWindowSearch("?window=lastMonth", "thisWeek")).toBe("");
    expect(usageWindowSearch("?window=thisWeek", "lastMonth")).toBe("?window=lastMonth");
  });
});

describe("calendar periods", () => {
  const NOW = new Date(2026, 9, 22, 14, 30);
  const local = (...parts: [number, number, number]) => new Date(...parts).toISOString();

  test("weeks start on Monday and months on the first, in the viewer's time", () => {
    expect(windowBounds("thisWeek", NOW)).toEqual({
      window: "thisWeek",
      from: local(2026, 9, 19),
      to: NOW.toISOString(),
    });
    expect(windowBounds("lastWeek", NOW)).toEqual({
      window: "lastWeek",
      from: local(2026, 9, 12),
      to: local(2026, 9, 19),
    });
    expect(windowBounds("thisMonth", NOW)).toEqual({
      window: "thisMonth",
      from: local(2026, 9, 1),
      to: NOW.toISOString(),
    });
    expect(windowBounds("lastMonth", NOW)).toEqual({
      window: "lastMonth",
      from: local(2026, 8, 1),
      to: local(2026, 9, 1),
    });
  });

  test("a Sunday still belongs to the week that began on Monday", () => {
    expect(windowBounds("thisWeek", new Date(2026, 9, 25, 23, 0)).from).toBe(local(2026, 9, 19));
  });

  test("last month crosses the year boundary", () => {
    expect(windowBounds("lastMonth", new Date(2026, 0, 15))).toMatchObject({
      from: local(2025, 11, 1),
      to: local(2026, 0, 1),
    });
  });

  test("the engine buckets in the viewer's time zone", () => {
    const query = new URLSearchParams(
      llmStatsEndpoint(windowBounds("lastWeek", NOW)).split("?")[1] ?? "",
    );
    expect(query.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(query.get("bucket")).toBe("day");
  });
});

describe("the engine's operating figures", () => {
  const NOW = new Date("2026-08-10T12:00:00.000Z");

  test("are asked over the window's two fixed instants", () => {
    const bounds = windowBounds("lastMonth", NOW);
    const endpoint = resolveApiPath(
      "/v1/stats/operating-figures",
      undefined,
      operatingFiguresQuery(bounds),
    );
    expect(endpoint.startsWith("/v1/stats/operating-figures?")).toBe(true);
    const query = new URLSearchParams(endpoint.slice(endpoint.indexOf("?")));
    expect([query.get("from"), query.get("to")]).toEqual([bounds.from, bounds.to]);
  });

  test("reads the counts and the engine's own percentages, not a second rounding", () => {
    expect(
      operatingCounts({
        schema_version: "operating-figures.v1",
        window: { from: "a", to: "b" },
        runs: { total: 40, succeeded: 36, failed: 4, success_rate_percent: 91 },
        connectors: { enabled: 8, not_ok: 2, needs_reauth: 1, healthy_percent: 75 },
        repairs: { decided: 4, applied: 3, applied_percent: 75 },
      }),
    ).toEqual({
      runs: { total: 40, failed: 4, successRatePercent: 91 },
      connectors: { enabled: 8, notOk: 2, needsReauth: 1, healthyPercent: 75 },
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
  const WEEK = windowBounds("thisWeek", NOW);
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
    monthly_budget_state: "ample",
  });
  const counts = (over: Partial<OperatingCounts> = {}) =>
    answered<OperatingCounts | null>({
      runs: { total: 40, failed: 2, successRatePercent: 95 },
      connectors: { enabled: 8, notOk: 2, needsReauth: 1, healthyPercent: 75 },
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
    const day = new URLSearchParams(windowStatsQuery(windowBounds("24h", NOW)));
    expect([day.get("bucket"), day.get("from"), day.get("to")]).toEqual([
      "hour",
      "2026-08-09T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
    ]);
    expect(new URLSearchParams(windowStatsQuery(WEEK)).get("bucket")).toBe("day");
    expect(new URLSearchParams(windowStatsQuery(WEEK)).get("from")).toBe(WEEK.from);
    expect(windowBucket("24h")).toBe("hour");
    expect(windowBucket("lastMonth")).toBe("day");
    const figures = new URLSearchParams(operatingFiguresQuery(WEEK));
    expect([figures.get("from"), figures.get("to")]).toEqual([WEEK.from, WEEK.to]);
  });

  test("tile detail preserves observed failure and unhealthy counts", () => {
    const figures = figuresOf({
      counts: counts({
        runs: { total: 12, failed: 3, successRatePercent: 75 },
        connectors: { enabled: 5, notOk: 2, needsReauth: 1, healthyPercent: 60 },
      }),
    });
    expect(value(figures.find((figure) => figure.id === "runs"))?.detail).toEqual({
      kind: "failures",
      count: 3,
    });
    expect(value(figures.find((figure) => figure.id === "connectorHealth"))?.detail).toEqual({
      kind: "connectors",
      count: 2,
      needsReauth: 1,
    });
    expect(
      figuresOf({ counts: { state: "failed" } })
        .filter((figure) => figure.id === "runs" || figure.id === "connectorHealth")
        .every((figure) => figure.state === "unreadable"),
    ).toBe(true);
  });

  test("every link opens the list the number counted: same window, same filter", () => {
    const figures = figuresOf();
    expect(figures.map((figure) => [figure.id, value(figure)?.value])).toEqual([
      ["runs", 40],
      ["successRate", 95],
      ["connectorHealth", 75],
      ["repairRate", 75],
      ["cost", 87.22],
      ["budget", 87.22],
    ]);
    const [runs, rate, connectors, repairs, cost, budget] = figures.map(value);
    expect(usageWindowFromUrl(query(cost?.href ?? null))).toBe("thisWeek");
    expect(cost?.href).toBe("/usage");
    expect(budget?.href).toBe("/usage");
    const lastMonth = operatingFigures({
      bounds: windowBounds("lastMonth", NOW),
      counts: counts(),
      connectorsPermitted: true,
      spend: answered(priced),
      budget: answered(month),
      canOpen: all,
    });
    expect(value(lastMonth[5])?.href).toBe("/usage?window=lastMonth");
    const window = { startedFrom: WEEK.from, startedTo: WEEK.to };
    expect(filterFromUrl(query(runs?.href ?? null))).toMatchObject({ status: "all", ...window });
    const statsQuery = new URLSearchParams(operatingFiguresQuery(WEEK));
    expect([statsQuery.get("from"), statsQuery.get("to")]).toEqual([
      window.startedFrom,
      window.startedTo,
    ]);
    expect(filterFromUrl(query(rate?.href ?? null))).toMatchObject({ status: "failed", ...window });
    expect(attentionFromSearch(query(connectors?.href ?? null))).toBe("not_ok");
    const audit = auditFilterFromUrl(query(repairs?.href ?? null));
    expect(audit).toMatchObject({ scope: "all", tsFrom: WEEK.from, tsTo: WEEK.to });
    expect(audit.actions).toEqual([...DECIDED_REPAIR_ACTIONS]);
    expect(figures.map((figure) => figure.basis)).toEqual([
      "window",
      "window",
      "now",
      "window",
      "window",
      "window",
    ]);
  });

  test("a link that would open an empty list is no link", () => {
    const [, rate, connectors] = figuresOf({
      counts: counts({
        runs: { total: 12, failed: 0, successRatePercent: 100 },
        connectors: { enabled: 5, notOk: 0, needsReauth: 0, healthyPercent: 100 },
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
        connectors: { enabled: 0, notOk: 0, needsReauth: 0, healthyPercent: null },
        repairs: { decided: 0, appliedPercent: null },
      }),
      spend: answered({ calls: 0, cost: windowCost({ cost: { amount: 0, currency: "USD" } }) }),
    });
    expect(figures.map((figure) => [figure.id, figure.state])).toEqual([
      ["runs", "none"],
      ["successRate", "none"],
      ["connectorHealth", "none"],
      ["repairRate", "none"],
      ["cost", "none"],
      ["budget", "none"],
    ]);
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
      ["budget", "value", 87.22],
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

  test("the typed stats query asks exactly what the shown endpoint names", () => {
    const filter = {
      results: ["error", "context_too_large"],
      workflowId: "w-1",
      userId: "u-1",
      flows: ["converse", "suggest_next"],
    };
    const cases = [
      llmStatsQuery(WEEK),
      llmStatsQuery(WEEK, "model"),
      llmStatsQuery(WEEK, ["workflow", "conversation"], filter),
    ];
    const endpoints = [
      llmStatsEndpoint(WEEK),
      llmStatsEndpoint(WEEK, "model"),
      llmStatsEndpoint(WEEK, ["workflow", "conversation"], filter),
    ];
    cases.forEach((query, index) => {
      expect([
        ...new URLSearchParams(resolveApiPath("/v1/stats/llm", undefined, query).split("?")[1]),
      ]).toEqual([...stats(endpoints[index] ?? "")]);
    });
  });

  test("the cost is the window's money, read over the figures' own bounds", () => {
    const endpoint = stats(llmStatsEndpoint(WEEK));
    expect([endpoint.get("from"), endpoint.get("to")]).toEqual([WEEK.from, WEEK.to]);
    expect(endpoint.get("group_by")).toBeNull();
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
    expect(cost && "href" in cost ? cost.href : null).toBe("/usage");
  });

  test("the period's usage is its money, with the month's whole share of the cap as its hint", () => {
    const at = (used: number, state = "ample") =>
      value(
        figuresOf({
          budget: answered(
            budgetSummary({
              tokens_month: used,
              monthly_budget_tokens: 1000,
              remaining_monthly_budget_tokens: Math.max(1000 - used, 0),
              monthly_budget_state: state,
            }),
          ),
        })[5],
      );
    expect([at(270)?.value, at(270)?.money]).toEqual([
      87.22,
      { currency: "USD", unpricedCalls: 0 },
    ]);
    expect(at(270)?.hint).toEqual({
      kind: "share",
      percent: 27,
      budgetTokens: 1000,
      remainingTokens: 730,
      pressure: "ample",
    });
    expect(at(750, "tightening")?.hint).toMatchObject({ percent: 75, pressure: "tightening" });
    expect(at(896, "tightening")?.hint).toMatchObject({ percent: 89, pressure: "tightening" });
    expect(at(270)?.basis).toBe("window");
  });

  test("a period without AI calls says so in every budget state and keeps the budget as its hint", () => {
    const none = answered({ calls: 0, cost: null });
    const uncapped = answered(budgetSummary({ tokens_month: 5_000, monthly_budget_tokens: null }));
    for (const window of ["24h", "lastWeek", "lastMonth"] as const) {
      for (const [budget, hint] of [
        [answered(month), { kind: "share", percent: 27 }],
        [uncapped, { kind: "uncapped", href: "/settings?leaf=tokens.monthly_budget" }],
        [{ state: "failed" as const }, { kind: "unreadable" }],
      ] as const) {
        const figure = operatingFigures({
          bounds: windowBounds(window, NOW),
          counts: counts(),
          connectorsPermitted: true,
          spend: none,
          budget,
          canOpen: all,
        })[5];
        expect([figure?.state, figure?.basis]).toEqual(["none", "window"]);
        expect(figure?.hint).toMatchObject(hint);
      }
    }
  });

  test("calls without a price say so, never a percentage in the amount's place", () => {
    const figure = figuresOf({ spend: answered({ calls: 30, cost: null }) })[5];
    expect(figure?.state).toBe("unpriced");
    expect(figure && "href" in figure ? figure.href : null).toBe("/usage");
    expect(figure?.hint).toMatchObject({ kind: "share", percent: 27 });
  });

  test("only the period's money decides readability; an unreadable budget is only the hint", () => {
    expect(figuresOf({ spend: { state: "failed" } })[5]).toEqual({
      id: "budget",
      state: "unreadable",
      basis: "window",
    });
    const figure = value(figuresOf({ budget: { state: "failed" } })[5]);
    expect([figure?.value, figure?.hint]).toEqual([87.22, { kind: "unreadable" }]);
  });

  test("no cap still shows the period's money, and the hint says there is no cap", () => {
    const uncapped = answered(budgetSummary({ tokens_month: 5_000, monthly_budget_tokens: null }));
    const figure = value(figuresOf({ budget: uncapped })[5]);
    expect([figure?.value, figure?.hint, figure?.href]).toEqual([
      87.22,
      { kind: "uncapped", href: "/settings?leaf=tokens.monthly_budget" },
      "/usage",
    ]);
    const readOnly = value(
      figuresOf({ budget: uncapped, canOpen: { ...all, budgetSetting: false } })[5],
    );
    expect(readOnly?.hint).toEqual({ kind: "uncapped", href: null });
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

describe("the repair-required count", () => {
  test("reads the total of the filtered workflow list and refuses malformed answers", () => {
    expect(resolveApiPath("/v1/workflows", undefined, REPAIR_REQUIRED_QUERY)).toBe(
      "/v1/workflows?operating_status=repair_required&limit=1",
    );
    expect(repairRequiredCount({ items: [], total: 13 })).toBe(13);
    expect(repairRequiredCount({ total: -1 })).toBeNull();
    expect(repairRequiredCount({ total: "13" })).toBeNull();
    expect(repairRequiredCount(null)).toBeNull();
  });
});

describe("the prompt-cache share per flow", () => {
  const envelope = {
    prompt_cache: {
      flows: [
        {
          flow: "converse",
          calls: 940,
          prompt_tokens: 76_000,
          cache_read_tokens: 59_000,
          cache_read_percent: 78,
        },
        {
          flow: "generate",
          calls: 180,
          prompt_tokens: 4_000,
          cache_read_tokens: 0,
          cache_read_percent: 0,
        },
        {
          flow: "workflow_step",
          calls: 3,
          prompt_tokens: 0,
          cache_read_tokens: 0,
          cache_read_percent: null,
        },
      ],
    },
  };

  test("reads each flow in engine order and keeps flows without provider data as no data", () => {
    expect(promptCacheFlows(envelope)).toEqual([
      { flow: "converse", calls: 940, promptTokens: 76_000, cacheReadTokens: 59_000, percent: 78 },
      { flow: "generate", calls: 180, promptTokens: 4_000, cacheReadTokens: 0, percent: 0 },
      { flow: "workflow_step", calls: 3, promptTokens: 0, cacheReadTokens: 0, percent: null },
    ]);
  });

  test("an answer without the cache block is unreadable, never an empty list", () => {
    expect(promptCacheFlows({ runs: {} })).toBeNull();
    expect(promptCacheFlows({ prompt_cache: { flows: "converse" } })).toBeNull();
    expect(promptCacheFlows(null)).toBeNull();
    expect(promptCacheFlows({ prompt_cache: { flows: [] } })).toEqual([]);
  });

  test("the overall share weighs flows by their prompt tokens, not by their percentages", () => {
    const flows = promptCacheFlows(envelope) ?? [];
    expect(promptCacheShare(flows)).toBe(74);
  });

  test("without prompt tokens there is no overall share, never a bare zero", () => {
    expect(promptCacheShare([])).toBeNull();
    expect(
      promptCacheShare([
        { flow: "converse", calls: 2, promptTokens: 0, cacheReadTokens: 0, percent: null },
      ]),
    ).toBeNull();
  });

  test("shares above the prompt volume are capped at one hundred percent", () => {
    expect(
      promptCacheShare([
        { flow: "converse", calls: 1, promptTokens: 100, cacheReadTokens: 130, percent: 100 },
      ]),
    ).toBe(100);
  });
});
