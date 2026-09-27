// What the workspace spent, and what it has left.
//
// The page called "Usage" answered with duration and success rate. The engine
// had measured tokens per model, per purpose, per user and per workflow all
// along and served them on `/v1/stats/llm`; the cap and the remainder sat on
// `/v1/status`. Neither was ever asked for, so an operator's only answer to
// "what does this cost us" was the terminal.
//
// The assertions below are mostly about the difference between nothing and
// zero, because that is the distinction this data keeps losing.

import { describe, expect, test } from "bun:test";
import {
  budgetPressure,
  budgetSummary,
  consumptionRows,
  llmStatsEndpoint,
} from "@/pages/usage-model";

describe("the consumption breakdown", () => {
  const envelope = {
    groups: [
      { key: "radar-publish-weekly", totals: { calls: { total: 12 }, tokens: { total: 250 } } },
      { key: "ga4-daily-report", totals: { calls: { total: 30 }, tokens: { total: 750 } } },
    ],
  };

  test("is ordered by what it costs, not by name", () => {
    expect(consumptionRows(envelope).map((r) => r.key)).toEqual([
      "ga4-daily-report",
      "radar-publish-weekly",
    ]);
  });

  test("shares add up to the whole", () => {
    const rows = consumptionRows(envelope);
    expect(rows[0]?.share).toBeCloseTo(0.75, 5);
    expect(rows[1]?.share).toBeCloseTo(0.25, 5);
    expect(rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 5);
  });

  test("a window that consumed nothing has no shares, not shares of zero", () => {
    // 0/0 is not 0 %. A row claiming "0 % of the month" reads as a measured
    // fact; there is nothing to take a share of.
    const rows = consumptionRows({
      groups: [{ key: "idle", totals: { calls: { total: 0 }, tokens: { total: 0 } } }],
    });
    expect(rows[0]?.share).toBeNull();
  });

  test("survives an envelope it does not recognise", () => {
    for (const bad of [null, undefined, {}, { groups: "nope" }, { groups: [1, 2] }]) {
      expect(consumptionRows(bad)).toEqual([]);
    }
  });

  test("asks for the axis it was given, over the same window as the rest of the page", () => {
    const at = new Date("2026-09-27T08:00:00.000Z");
    const url = llmStatsEndpoint("workflow", at);
    expect(url).toContain("group_by=workflow");
    expect(url).toContain("bucket=day");
    expect(url).toContain(encodeURIComponent("2026-08-28T08:00:00.000Z"));
  });
});

describe("the month against its cap", () => {
  test("reports the cap, the spend and the remainder", () => {
    const s = budgetSummary({
      tokens_month: 39_847_696,
      monthly_budget_tokens: 150_000_000,
      remaining_monthly_budget_tokens: 110_152_304,
    });
    expect(s.budgetTokens).toBe(150_000_000);
    expect(s.remainingTokens).toBe(110_152_304);
    expect(s.consumedShare).toBeCloseTo(0.2657, 3);
  });

  test("an absent cap is nothing, not a cap of zero", () => {
    // Rendering "no cap configured" as a cap of zero would tell an operator
    // their workspace is exhausted while nothing bounds it at all.
    const s = budgetSummary({ tokens_month: 5_000, monthly_budget_tokens: null });
    expect(s.budgetTokens).toBeNull();
    expect(s.consumedShare).toBeNull();
    expect(budgetPressure(s)).toBeNull();
  });

  test("an unbounded workspace is not reported as comfortable", () => {
    // `null`, not "ample": unbounded is unmeasured, and calling it healthy is
    // the zero that means "not measured".
    expect(budgetPressure(budgetSummary({ tokens_month: 1 }))).toBeNull();
  });

  test("names the pressure at the thresholds it claims", () => {
    const at = (used: number) =>
      budgetPressure(budgetSummary({ tokens_month: used, monthly_budget_tokens: 100 }));
    expect(at(10)).toBe("ample");
    expect(at(74)).toBe("ample");
    expect(at(75)).toBe("tightening");
    expect(at(89)).toBe("tightening");
    expect(at(90)).toBe("critical");
    expect(at(200)).toBe("critical");
  });

  test("an overspent month does not report more than all of it spent", () => {
    const s = budgetSummary({ tokens_month: 300, monthly_budget_tokens: 100 });
    expect(s.consumedShare).toBe(1);
  });
});
