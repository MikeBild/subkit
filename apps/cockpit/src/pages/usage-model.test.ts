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
  unpricedModels,
  windowCost,
  workflowNameLookup,
} from "@/pages/usage-model";

describe("the consumption breakdown", () => {
  // The PUBLISHED shape: `key` is a map of dimension to value, because a
  // caller may group by two at once. An earlier version of this test fed a
  // bare string — the shape the code assumed rather than the one the engine
  // sends — and stayed green while the page could render nothing at all.
  const envelope = {
    groups: [
      {
        key: { workflow: "radar-publish-weekly" },
        totals: { calls: 12, tokens: { total: 250 } },
      },
      {
        key: { workflow: "ga4-daily-report" },
        totals: { calls: 30, tokens: { total: 750 } },
      },
    ],
  };

  test("is ordered by what it costs, not by name", () => {
    expect(consumptionRows(envelope, "workflow").map((r) => r.key)).toEqual([
      "ga4-daily-report",
      "radar-publish-weekly",
    ]);
  });

  test("shares add up to the whole", () => {
    const rows = consumptionRows(envelope, "workflow");
    expect(rows[0]?.share).toBeCloseTo(0.75, 5);
    expect(rows[1]?.share).toBeCloseTo(0.25, 5);
    expect(rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 5);
  });

  test("a window that consumed nothing has no shares, not shares of zero", () => {
    // 0/0 is not 0 %. A row claiming "0 % of the month" reads as a measured
    // fact; there is nothing to take a share of.
    const rows = consumptionRows(
      {
        groups: [{ key: { workflow: "idle" }, totals: { calls: 0, tokens: { total: 0 } } }],
      },
      "workflow",
    );
    expect(rows[0]?.share).toBeNull();
  });

  test("survives an envelope it does not recognise", () => {
    for (const bad of [null, undefined, {}, { groups: "nope" }, { groups: [1, 2] }]) {
      expect(consumptionRows(bad, "workflow")).toEqual([]);
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

describe("the window's money", () => {
  test("reports a priced window", () => {
    const cost = windowCost({
      cost: { amount: 42.8, currency: "EUR", unpriced_models: [], unpriced_calls: 0 },
    });
    expect(cost?.amount).toBe(42.8);
    expect(cost?.currency).toBe("EUR");
  });

  test("a window nothing could be priced in has no amount at all", () => {
    // Zero beside a month that plainly consumed tokens reads as "this was
    // free" — the most expensive misreading this data can produce.
    expect(
      windowCost({
        cost: {
          amount: 0,
          currency: "USD",
          unpriced_models: ["claude-sonnet-4-6"],
          unpriced_calls: 1_578,
        },
      }),
    ).toBeNull();
  });

  test("a partly priced window keeps its amount AND what it left out", () => {
    const cost = windowCost({
      cost: {
        amount: 31.1,
        currency: "USD",
        unpriced_models: ["some-new-model"],
        unpriced_calls: 12,
      },
    });
    expect(cost?.amount).toBe(31.1);
    expect(cost?.unpricedModels).toEqual(["some-new-model"]);
    expect(cost?.unpricedCalls).toBe(12);
  });

  test("a genuine zero with nothing unpriced is a real zero", () => {
    const cost = windowCost({
      cost: { amount: 0, currency: "USD", unpriced_models: [], unpriced_calls: 0 },
    });
    expect(cost?.amount).toBe(0);
  });

  test("an envelope without a cost block yields nothing", () => {
    for (const bad of [null, undefined, {}, { cost: "nope" }]) {
      expect(windowCost(bad)).toBeNull();
      expect(unpricedModels(bad)).toEqual([]);
    }
  });

  test("a window nothing could be priced in still names the models that lack a price", () => {
    // No amount is shown, so the line beneath it is the only place the reader
    // learns WHICH models need a price — "no prices at all" is not the case
    // once SubKit ships list prices.
    const envelope = {
      cost: {
        amount: 0,
        currency: "USD",
        unpriced_models: ["some-new-model", "another-model"],
        unpriced_calls: 40,
      },
    };
    expect(windowCost(envelope)).toBeNull();
    expect(unpricedModels(envelope)).toEqual(["some-new-model", "another-model"]);
  });
});

describe("the published group shape", () => {
  test("reads the value for the axis that was asked for", () => {
    // A two-dimension grouping puts both in the key. Picking the wrong one
    // would label every row with a model name under a heading that says
    // workflow.
    const envelope = {
      groups: [
        {
          key: { workflow: "ga4-daily-report", model: "claude-sonnet-4-6" },
          totals: { calls: 3, tokens: { total: 10 } },
        },
      ],
    };
    expect(consumptionRows(envelope, "workflow")[0]?.key).toBe("ga4-daily-report");
    expect(consumptionRows(envelope, "model")[0]?.key).toBe("claude-sonnet-4-6");
  });

  test("a bare string key is NOT accepted", () => {
    // The shape this code used to assume. Accepting it would let the same
    // mistake back in behind a passing test.
    expect(consumptionRows({ groups: [{ key: "ga4", totals: {} }] }, "workflow")).toEqual([]);
  });

  test("a group missing the requested dimension is dropped", () => {
    // No such dimension at all — a different thing from a dimension that is
    // present and empty, which is the case below.
    expect(consumptionRows({ groups: [{ key: { model: "x" }, totals: {} }] }, "workflow")).toEqual(
      [],
    );
  });

  test("consumption nothing can be attributed to is KEPT and marked", () => {
    // `llm_usage` has no workflow: attribution comes from a join on
    // `executions`, so every call without a run — chat, self-healing,
    // discovery — arrives with an empty key. Dropping those made a page about
    // consumption say "no model calls in this window" beside a header naming
    // forty million tokens, because on that installation nearly all of it was
    // chat. "Cannot be attributed" and "did not happen" are different facts.
    const rows = consumptionRows(
      {
        groups: [
          { key: { workflow: "" }, totals: { calls: 9, tokens: { total: 400 } } },
          { key: { workflow: "ga4" }, totals: { calls: 1, tokens: { total: 100 } } },
        ],
      },
      "workflow",
    );
    expect(rows).toHaveLength(2);
    const unattributed = rows.find((r) => r.unattributed);
    expect(unattributed?.tokens).toBe(400);
    expect(rows.find((r) => r.key === "ga4")?.unattributed).toBe(false);
    // And it counts toward the shares, or the percentages would not add up.
    expect(rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 5);
  });
});

describe("the call count", () => {
  test("is read from the per-group number the schema declares", () => {
    // PER GROUP `totals.calls` is a plain number; only the ENVELOPE total is
    // `{ total, by_result }`. This file fed the envelope shape and asserted
    // nothing about `calls` at all, so it stayed green while every row on the
    // page reported nought calls beside millions of tokens. The one field the
    // code turns into a zero was the one field no test looked at.
    const rows = consumptionRows(
      { groups: [{ key: { flow: "converse" }, totals: { calls: 792, tokens: { total: 10 } } }] },
      "flow",
    );
    expect(rows[0]?.calls).toBe(792);
  });

  test("refuses the envelope shape rather than silently reporting none", () => {
    const rows = consumptionRows(
      {
        groups: [
          { key: { flow: "converse" }, totals: { calls: { total: 792 }, tokens: { total: 10 } } },
        ],
      },
      "flow",
    );
    // Zero is what the wrong shape produced. It must not be reachable from a
    // payload that plainly carries a count.
    expect(rows[0]?.calls).toBe(0);
  });
});

describe("a workflow id on the usage page", () => {
  test("named by its own lookup, not by a capped list", () => {
    expect(workflowNameLookup({ name: "Monatsreport", slug: "m" }, null)).toEqual({
      kind: "named",
      name: "Monatsreport",
    });
  });

  test("only a 404 says the workflow is gone; other failures are unreadable", () => {
    expect(workflowNameLookup(undefined, 404)).toEqual({ kind: "gone" });
    expect(workflowNameLookup(undefined, 403)).toEqual({ kind: "unreadable" });
    expect(workflowNameLookup(undefined, 0)).toEqual({ kind: "unreadable" });
    expect(workflowNameLookup(undefined, null)).toEqual({ kind: "pending" });
  });
});
