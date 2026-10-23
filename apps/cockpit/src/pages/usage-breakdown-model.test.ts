import { describe, expect, test } from "bun:test";
import { llmStatsEndpoint, previousBounds, windowBounds } from "@/pages/operations-figures";
import {
  type BreakdownRow,
  breakdown,
  bucketTimeline,
  budgetForecast,
  failureRows,
  llmWindow,
  mainDriver,
  originChart,
  runCostFactor,
  trendOf,
  usageCsv,
  usageHints,
} from "@/pages/usage-model";

function group(
  key: Record<string, string>,
  values: {
    calls?: number;
    total?: number;
    prompt?: number;
    cost?: number | null;
    unpriced?: number;
    result?: Record<string, number>;
    buckets?: Array<{ ts: string; cost?: number; tokens?: number; calls?: number }>;
    conversation?: { title: string | null; owner_id: string | null; updated_at: string };
  } = {},
) {
  return {
    key,
    totals: {
      calls: values.calls ?? 1,
      tokens: { prompt: values.prompt ?? 0, total: values.total ?? 0 },
      latency_ms: { p50: 900 },
      result: values.result ?? {},
    },
    ...(values.cost === undefined || values.cost === null
      ? values.unpriced
        ? {
            cost: { amount: 0, currency: "USD", unpriced_calls: values.unpriced, cache_savings: 0 },
          }
        : {}
      : {
          cost: {
            amount: values.cost,
            currency: "USD",
            unpriced_calls: values.unpriced ?? 0,
            cache_savings: 0,
          },
        }),
    ...(values.conversation ? { conversation: values.conversation } : {}),
    buckets: (values.buckets ?? []).map((bucket) => ({
      ts: bucket.ts,
      calls: bucket.calls ?? 1,
      tokens: {
        prompt: 0,
        completion: 0,
        cache_read: 0,
        cache_creation: 0,
        total: bucket.tokens ?? 0,
      },
      ...(bucket.cost === undefined
        ? {}
        : {
            cost: { amount: bucket.cost, currency: "USD", unpriced_calls: 0, cache_savings: 0 },
          }),
    })),
  };
}

function envelope(
  groups: unknown[],
  window: { calls: number; total?: number; prompt?: number; cacheRead?: number; cost?: number },
) {
  return {
    groups,
    totals: {
      calls: { total: window.calls, by_result: { success: window.calls - 2, error: 2 } },
      tokens: {
        prompt: window.prompt ?? 0,
        completion: 0,
        cache_read: window.cacheRead ?? 0,
        cache_creation: 0,
        total: window.total ?? 0,
      },
    },
    cost: {
      amount: window.cost ?? 0,
      currency: "USD",
      unpriced_models: [],
      unpriced_calls: 0,
      cache_savings: 3.5,
    },
  };
}

describe("the trend against the window before", () => {
  test("stays about the same below five percent either way", () => {
    expect(trendOf(104.9, 100)).toEqual({ kind: "same" });
    expect(trendOf(95.1, 100)).toEqual({ kind: "same" });
  });

  test("names more or less from five percent on, rounded and without sign", () => {
    expect(trendOf(105, 100)).toEqual({ kind: "more", percent: 5 });
    expect(trendOf(62.4, 100)).toEqual({ kind: "less", percent: 38 });
  });

  test("is new when nothing was used before, and absent without a comparison", () => {
    expect(trendOf(3, 0)).toEqual({ kind: "new" });
    expect(trendOf(0, 0)).toEqual({ kind: "same" });
    expect(trendOf(3, undefined)).toEqual({ kind: "none" });
    expect(trendOf(null, 4)).toEqual({ kind: "none" });
  });
});

describe("the window before", () => {
  test("for this week runs to the same weekday and time last week", () => {
    const now = new Date(2026, 9, 22, 14, 30);
    const span = previousBounds(windowBounds("thisWeek", now));
    expect(new Date(span.from)).toEqual(new Date(2026, 9, 12));
    expect(new Date(span.to)).toEqual(new Date(2026, 9, 15, 14, 30));
  });

  test("for this month stops at the same day last month and clamps a short month", () => {
    const span = previousBounds(windowBounds("thisMonth", new Date(2026, 2, 31, 9)));
    expect(new Date(span.from)).toEqual(new Date(2026, 1, 1));
    expect(new Date(span.to)).toEqual(new Date(2026, 1, 28, 9));
  });

  test("for closed windows is the window of the same length right before", () => {
    const now = new Date(2026, 9, 22, 14, 30);
    const week = previousBounds(windowBounds("lastWeek", now));
    expect(new Date(week.from)).toEqual(new Date(2026, 9, 5));
    expect(new Date(week.to)).toEqual(new Date(2026, 9, 12));
    const month = previousBounds(windowBounds("lastMonth", now));
    expect(new Date(month.from)).toEqual(new Date(2026, 7, 1));
    expect(new Date(month.to)).toEqual(new Date(2026, 8, 1));
    const day = previousBounds(windowBounds("24h", now));
    expect(new Date(day.to).getTime() - new Date(day.from).getTime()).toBe(24 * 3_600_000);
    expect(day.to).toBe(windowBounds("24h", now).from);
  });

  test("keeps the wall-clock time across a daylight saving change", () => {
    const span = previousBounds(windowBounds("thisWeek", new Date(2026, 2, 31, 10)));
    expect(new Date(span.to).getHours()).toBe(10);
  });
});

describe("the request for usage figures", () => {
  test("carries the breakdown, failed results, a workflow and a person", () => {
    const bounds = windowBounds("thisWeek", new Date(2026, 9, 22, 14, 30));
    const url = llmStatsEndpoint(bounds, ["workflow", "conversation"], {
      results: ["error", "context_too_large"],
      workflowId: "w-1",
      userId: "u-1",
      flows: ["converse", "suggest_next"],
    });
    expect(url).toContain("group_by=workflow,conversation");
    expect(url).toContain("result=error,context_too_large");
    expect(url).toContain("workflow_id=w-1");
    expect(url).toContain("user_id=u-1");
    expect(url).toContain("flow=converse,suggest_next");
    expect(url).toContain("bucket=day");
  });
});

describe("the monthly budget forecast", () => {
  const base = { usedTokens: 50_000_000, budgetTokens: 100_000_000 };

  test("lasts to month end when the last seven days project well under the budget", () => {
    const now = new Date(2026, 9, 15, 12);
    expect(budgetForecast({ ...base, lastSevenDaysTokens: 7_000_000, now })).toEqual({
      kind: "lasts",
    });
  });

  test("names the day it runs out from the last seven days", () => {
    const now = new Date(2026, 9, 10, 0);
    const result = budgetForecast({ ...base, lastSevenDaysTokens: 35_000_000, now });
    expect(result).toEqual({ kind: "runsOut", day: 20 });
  });

  test("is tight between ninety and one hundred percent", () => {
    const now = new Date(2026, 9, 21, 0);
    const result = budgetForecast({
      usedTokens: 80_000_000,
      budgetTokens: 100_000_000,
      lastSevenDaysTokens: 7_000_000,
      now,
    });
    expect(result).toEqual({ kind: "tight", percent: 91 });
  });

  test("is used up, uncapped, or too early in the month", () => {
    const now = new Date(2026, 9, 15);
    expect(
      budgetForecast({ usedTokens: 100, budgetTokens: 100, lastSevenDaysTokens: 0, now }),
    ).toEqual({ kind: "exhausted" });
    expect(
      budgetForecast({ usedTokens: 1, budgetTokens: null, lastSevenDaysTokens: 0, now }),
    ).toEqual({ kind: "uncapped" });
    expect(budgetForecast({ ...base, lastSevenDaysTokens: 1, now: new Date(2026, 9, 2) })).toEqual({
      kind: "insufficient",
    });
  });

  test("gives the same answer for the same input", () => {
    const input = { ...base, lastSevenDaysTokens: 35_000_000, now: new Date(2026, 9, 10) };
    expect(budgetForecast(input)).toEqual(budgetForecast({ ...input }));
  });
});

describe("the breakdown", () => {
  const window = llmWindow(envelope([], { calls: 10, total: 1000, cost: 10 }));
  if (!window) throw new Error("window fixture");

  test("orders rows by cost and puts what no row covers into one remainder row", () => {
    const current = envelope(
      [
        group({ workflow: "a" }, { calls: 2, total: 200, cost: 2 }),
        group({ workflow: "b" }, { calls: 5, total: 500, cost: 5 }),
        group({ workflow: "" }, { calls: 3, total: 300, cost: 3 }),
      ],
      { calls: 10, total: 1000, cost: 10 },
    );
    const result = breakdown(current, "workflow", window);
    expect(result.rows.map((row) => row.key)).toEqual(["b", "a"]);
    expect(result.rows[0]?.share).toBeCloseTo(0.5, 6);
    expect(result.remainder).toEqual({ cost: 3, calls: 3, share: 0.3 });
  });

  test("has no remainder when the rows cover the window", () => {
    const current = envelope([group({ model: "m" }, { calls: 10, total: 1000, cost: 10 })], {
      calls: 10,
      total: 1000,
      cost: 10,
    });
    expect(breakdown(current, "model", window).remainder).toBeNull();
  });

  test("compares each row with the same row in the window before", () => {
    const current = envelope(
      [
        group({ workflow: "a" }, { cost: 2.06 }),
        group({ workflow: "b" }, { cost: 5 }),
        group({ workflow: "c" }, { cost: 1 }),
      ],
      { calls: 10, cost: 10 },
    );
    const before = envelope(
      [group({ workflow: "a" }, { cost: 2 }), group({ workflow: "b" }, { cost: 2 })],
      { calls: 4, cost: 4 },
    );
    const trends = Object.fromEntries(
      breakdown(current, "workflow", window, before).rows.map((row) => [row.key, row.trend]),
    );
    expect(trends.a).toEqual({ kind: "same" });
    expect(trends.b).toEqual({ kind: "more", percent: 150 });
    expect(trends.c).toEqual({ kind: "new" });
    expect(breakdown(current, "workflow", window).rows[0]?.trend).toEqual({ kind: "none" });
  });

  test("measures tokens when nothing in the window has a price", () => {
    const unpriced = llmWindow({
      totals: { calls: { total: 2 }, tokens: { total: 400 } },
      cost: { amount: 0, unpriced_calls: 2, unpriced_models: ["own"], currency: "USD" },
    });
    if (!unpriced) throw new Error("fixture");
    const current = envelope([group({ model: "own" }, { calls: 2, total: 400, unpriced: 2 })], {
      calls: 2,
    });
    const result = breakdown(current, "model", unpriced);
    expect(result.measure).toBe("tokens");
    expect(result.rows[0]?.cost).toBeNull();
    expect(result.rows[0]?.share).toBe(1);
  });
});

describe("the window figures", () => {
  test("count failed calls and the share of input read from the cache", () => {
    const window = llmWindow(
      envelope([], { calls: 10, prompt: 1000, cacheRead: 250, total: 1200, cost: 4 }),
    );
    expect(window?.failedCalls).toBe(2);
    expect(window?.cacheShare).toBe(0.25);
    expect(window?.cacheSavings).toBe(3.5);
  });
});

describe("cost over time", () => {
  test("stacks each day by origin and fills days without calls", () => {
    const bounds = {
      from: new Date(2026, 9, 19).toISOString(),
      to: new Date(2026, 9, 22, 9).toISOString(),
    };
    const chart = originChart(
      {
        groups: [
          group(
            { flow: "converse" },
            { cost: 3, buckets: [{ ts: "2026-10-19T00:00:00.000Z", cost: 3 }] },
          ),
          group(
            { flow: "workflow_step" },
            {
              cost: 5,
              buckets: [
                { ts: "2026-10-19T00:00:00.000Z", cost: 1 },
                { ts: "2026-10-21T00:00:00.000Z", cost: 4 },
              ],
            },
          ),
        ],
      },
      bounds,
      "day",
    );
    expect(chart.measure).toBe("cost");
    expect(chart.buckets.map((b) => b.total)).toEqual([4, 0, 4, 0]);
    expect(chart.buckets[0]?.values.chat).toBe(3);
    expect(chart.buckets[0]?.values.workflowRuns).toBe(1);
  });

  test("has one bar per hour for the last 24 hours", () => {
    const now = new Date(2026, 9, 22, 14, 30);
    expect(bucketTimeline(windowBounds("24h", now), "hour")).toHaveLength(25);
  });
});

describe("worth a look", () => {
  const person = (key: string, share: number) => ({ key, share }) as unknown as BreakdownRow;

  test("names workflows whose run got at least one and a half times as expensive", () => {
    expect(
      runCostFactor({ workflowId: "w", cost: 9, runs: 3, previousCost: 4, previousRuns: 4 }),
    ).toBe(3);
    const hints = usageHints({
      workflows: [
        { workflowId: "w", cost: 9, runs: 3, previousCost: 4, previousRuns: 4 },
        { workflowId: "v", cost: 1.4, runs: 1, previousCost: 1, previousRuns: 1 },
        { workflowId: "x", cost: 2, runs: 1, previousCost: 0, previousRuns: 0 },
      ],
      unpricedModels: [],
      forecast: null,
      persons: null,
    });
    expect(hints).toEqual([{ kind: "runCost", workflowId: "w", factor: 3 }]);
  });

  test("names unpriced models, the budget day and a person with most of the cost", () => {
    expect(
      usageHints({
        workflows: [],
        unpricedModels: ["own"],
        forecast: { kind: "runsOut", day: 29 },
        persons: [person("u1", 0.62), person("u2", 0.38)],
      }),
    ).toEqual([
      { kind: "unpricedModel", model: "own" },
      { kind: "budget", day: 29 },
      { kind: "personShare", userId: "u1", percent: 62 },
    ]);
    expect(
      usageHints({ workflows: [], unpricedModels: ["a", "b"], forecast: null, persons: null }),
    ).toEqual([{ kind: "unpricedModels", count: 2 }]);
  });

  test("stays empty when nothing changed clearly", () => {
    expect(
      usageHints({
        workflows: [],
        unpricedModels: [],
        forecast: { kind: "lasts" },
        persons: [person("u1", 1)],
      }),
    ).toEqual([]);
  });
});

describe("the main driver", () => {
  test("is the item whose cost grew most", () => {
    expect(
      mainDriver(
        [
          { key: "a", cost: 10 },
          { key: "b", cost: 20 },
          { key: "c", cost: null },
        ],
        new Map([
          ["a", 2],
          ["b", 18],
        ]),
      ),
    ).toEqual({ key: "a", delta: 8 });
    expect(mainDriver([{ key: "a", cost: 1 }], new Map([["a", 2]]))).toBeNull();
  });
});

describe("failed calls", () => {
  test("list where they happen with their reasons and what they cost", () => {
    const rows = failureRows({
      groups: [
        group(
          { workflow: "w", conversation: "" },
          { cost: 0.4, result: { error: 3, context_too_large: 1 } },
        ),
        group(
          { workflow: "", conversation: "c" },
          {
            cost: 1.2,
            result: { error: 1 },
            conversation: {
              title: "Bericht",
              owner_id: "u",
              updated_at: "2026-10-20T10:00:00.000Z",
            },
          },
        ),
        group({ workflow: "", conversation: "" }, { cost: 0, result: {} }),
      ],
    });
    expect(rows.map((row) => [row.workflowId, row.conversationId, row.title, row.calls])).toEqual([
      [null, "c", "Bericht", 1],
      ["w", null, null, 4],
    ]);
    expect(rows[1]?.reasons).toEqual([
      { result: "error", calls: 3 },
      { result: "context_too_large", calls: 1 },
    ]);
  });
});

describe("the export", () => {
  test("has one line per day, origin and model in a stable order", () => {
    const csv = usageCsv(
      {
        cost: { currency: "USD" },
        groups: [
          group(
            { flow: "workflow_step", model: "gpt" },
            { buckets: [{ ts: "2026-10-20T00:00:00.000Z", cost: 1.5, calls: 2, tokens: 10 }] },
          ),
          group(
            { flow: "converse", model: "own, eigenes" },
            { buckets: [{ ts: "2026-10-19T00:00:00.000Z", calls: 1, tokens: 5 }] },
          ),
        ],
      },
      "day",
      {
        period: "Tag",
        origin: "Herkunft",
        model: "Modell",
        calls: "KI-Aufrufe",
        input: "Eingabe-Token",
        output: "Ausgabe-Token",
        cacheRead: "Aus Cache gelesen",
        cacheWritten: "In Cache geschrieben",
        cost: "Kosten",
        currency: "Währung",
        originName: (origin) => (origin === "chat" ? "Chat" : "Workflow-Läufe"),
      },
    );
    expect(csv.split("\r\n")).toEqual([
      "Tag,Herkunft,Modell,KI-Aufrufe,Eingabe-Token,Ausgabe-Token,Aus Cache gelesen,In Cache geschrieben,Kosten,Währung",
      '2026-10-19,Chat,"own, eigenes",1,0,0,0,0,,',
      "2026-10-20,Workflow-Läufe,gpt,2,0,0,0,0,1.5,USD",
    ]);
  });
});
