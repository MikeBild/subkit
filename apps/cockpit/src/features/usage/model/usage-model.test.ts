import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { llmStatsEndpoint, windowBounds } from "@/features/usage/model/operations-figures";
import {
  attributableWorkflowRows,
  budgetPercent,
  budgetPressure,
  budgetSummary,
  consumptionRows,
  FLOW_ORIGIN,
  flowOrigin,
  llmGroups,
  mergeModelPrice,
  modelPriceApplied,
  originRows,
  promptCacheOf,
  runsByWorkflow,
  unpricedModels,
  windowCost,
  workflowNameLookup,
} from "@/features/usage/model/usage-model";

describe("the consumption breakdown", () => {
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

  test("a model row carries the engine's name for it; an unknown model keeps its id", () => {
    const rows = consumptionRows(
      {
        groups: [
          {
            key: { model: "claude-haiku-4-5-20251001" },
            model_name: "Claude Haiku 4.5",
            totals: { calls: 3, tokens: { total: 300 } },
          },
          { key: { model: "my-local-model" }, totals: { calls: 1, tokens: { total: 100 } } },
        ],
      },
      "model",
    );
    expect(rows.map((r) => r.name ?? r.key)).toEqual(["Claude Haiku 4.5", "my-local-model"]);
  });

  test("shares add up to the whole", () => {
    const rows = consumptionRows(envelope, "workflow");
    expect(rows[0]?.share).toBeCloseTo(0.75, 5);
    expect(rows[1]?.share).toBeCloseTo(0.25, 5);
    expect(rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 5);
  });

  test("a window that consumed nothing has no shares, not shares of zero", () => {
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
    const bounds = windowBounds("lastMonth", at);
    const url = llmStatsEndpoint(bounds, "workflow");
    expect(url).toContain("group_by=workflow");
    expect(url).toContain("bucket=day");
    expect(url).toContain(encodeURIComponent(bounds.from));
    expect(llmStatsEndpoint(windowBounds("24h", at), "model")).toContain("bucket=hour");
  });
});

describe("the month against the AI budget", () => {
  const status = (ai_budget: Record<string, unknown>) => ({ tokens_month: 1, ai_budget });

  test("reports the limit, the spend and its currency", () => {
    const s = budgetSummary(status({ currency: "USD", limit: 50, spent: 12.4, state: "ok" }));
    expect(s).toEqual({ currency: "USD", limit: 50, spent: 12.4, state: "ok" });
    expect(budgetPressure(s)).toBe("ample");
    expect(budgetPercent(s)).toBe(24);
  });

  test("no limit is nothing, not a limit of zero, and never comfortable", () => {
    const s = budgetSummary(status({ currency: "USD", limit: null, spent: 3, state: "unlimited" }));
    expect(s.limit).toBeNull();
    expect(budgetPercent(s)).toBeNull();
    expect(budgetPressure(s)).toBeNull();
    expect(budgetPressure(budgetSummary({ tokens_month: 1 }))).toBeNull();
  });

  test("the pressure is the engine's state, never a local rule", () => {
    expect(budgetPressure(budgetSummary(status({ limit: 50, spent: 1, state: "reached" })))).toBe(
      "critical",
    );
    expect(budgetPressure(budgetSummary(status({ limit: 50, spent: 1, state: "warning" })))).toBe(
      "tightening",
    );
  });

  test("the percentage is rounded down", () => {
    expect(
      budgetPercent(budgetSummary(status({ limit: 100, spent: 89.6, state: "warning" }))),
    ).toBe(89);
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
    expect(consumptionRows({ groups: [{ key: "ga4", totals: {} }] }, "workflow")).toEqual([]);
  });

  test("a group missing the requested dimension is dropped", () => {
    expect(consumptionRows({ groups: [{ key: { model: "x" }, totals: {} }] }, "workflow")).toEqual(
      [],
    );
  });

  test("consumption nothing can be attributed to is KEPT and marked", () => {
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
    expect(rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 5);
  });
});

describe("the call count", () => {
  test("is read from the per-group number the schema declares", () => {
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

describe("a saved model price", () => {
  const envelope = (price?: { input_per_mtok: number; output_per_mtok: number }) => ({
    groups: [
      {
        key: { model: "gpt-x" },
        totals: { calls: 1, tokens: { total: 100 } },
        ...(price ? { model_price: { ...price, currency: "USD" } } : {}),
      },
    ],
  });

  test("the old rates still in the read do not count as applied", () => {
    expect(
      modelPriceApplied(envelope({ input_per_mtok: 10, output_per_mtok: 20 }), "gpt-x", 15, 30),
    ).toBe(false);
  });

  test("the new rates in the read count as applied", () => {
    expect(
      modelPriceApplied(envelope({ input_per_mtok: 15, output_per_mtok: 30 }), "gpt-x", 15, 30),
    ).toBe(true);
  });

  test("an unpriced or missing model is not applied", () => {
    expect(modelPriceApplied(envelope(), "gpt-x", 15, 30)).toBe(false);
    expect(
      modelPriceApplied(envelope({ input_per_mtok: 15, output_per_mtok: 30 }), "other", 15, 30),
    ).toBe(false);
  });
});

describe("money per group", () => {
  const group = (workflow: string, tokens: number, cost?: unknown) => ({
    key: { workflow },
    totals: { calls: 1, tokens: { total: tokens } },
    ...(cost === undefined ? {} : { cost }),
  });

  test("a priced breakdown is ordered and shared by money, not by tokens", () => {
    const rows = consumptionRows(
      {
        groups: [
          group("cheap", 900, { amount: 1, currency: "EUR", unpriced_calls: 0 }),
          group("dear", 100, { amount: 3, currency: "EUR", unpriced_calls: 0 }),
        ],
      },
      "workflow",
    );
    expect(rows.map((row) => row.key)).toEqual(["dear", "cheap"]);
    expect(rows[0]?.cost).toBe(3);
    expect(rows[0]?.share).toBeCloseTo(0.75, 6);
  });

  test("an unpriced group has no amount, and the column falls back to tokens", () => {
    const rows = consumptionRows(
      {
        groups: [
          group("a", 900, { amount: 0, currency: "EUR", unpriced_calls: 4 }),
          group("b", 100, { amount: 3, currency: "EUR", unpriced_calls: 0 }),
        ],
      },
      "workflow",
    );
    expect(rows.find((row) => row.key === "a")?.cost).toBeNull();
    expect(rows[0]?.key).toBe("a");
    expect(rows[0]?.share).toBeCloseTo(0.9, 6);
  });
});

describe("runs per workflow", () => {
  test("reads each workflow's run count and skips what it cannot read", () => {
    const runs = runsByWorkflow({
      groups: [
        { key: { workflow_id: "w1" }, totals: { executions: 7 } },
        { key: { workflow_id: "" }, totals: { executions: 2 } },
        { key: {}, totals: { executions: 1 } },
        "junk",
      ],
    });
    expect([...runs]).toEqual([["w1", 7]]);
    expect(runsByWorkflow(null).size).toBe(0);
  });
});

describe("what the money was spent on", () => {
  const flow = (key: string, total: number, amount: number | null, calls = 1) => ({
    key: { flow: key },
    totals: { calls, tokens: { total } },
    ...(amount === null ? {} : { cost: { amount, currency: "USD", unpriced_calls: 0 } }),
  });

  test("names every flow the engine records — a new one breaks here, not on the page", () => {
    const source = readFileSync(
      new URL("../../../../../engine/src/llm/types.ts", import.meta.url),
      "utf8",
    );
    const union = source.slice(source.indexOf("export type LlmFlow"));
    const flows = [...union.slice(0, union.indexOf(";")).matchAll(/\|\s*"([a-z_]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(flows.length).toBeGreaterThan(5);
    expect(Object.keys(FLOW_ORIGIN).sort()).toEqual([...flows].sort());
  });

  test("folds purposes into what a reader recognises, largest first", () => {
    const rows = originRows({
      groups: [
        flow("converse", 900, 131.42, 600),
        flow("suggest_next", 10, 0.01),
        flow("summarize", 50, 3.09),
        flow("generate", 30, 0.66),
        flow("repair", 10, 0.3),
        flow("critic_authoring", 2, 0.03),
        flow("tool_repair", 1, 0.01),
        flow("judge", 9, 0.29),
      ],
    });
    expect(rows.map((row) => row.key)).toEqual(["chat", "summaries", "authoring", "reviews"]);
    expect(rows[0]?.cost).toBeCloseTo(131.43, 5);
    expect(rows[2]?.cost).toBeCloseTo(1, 5);
    expect(rows[0]?.flows).toEqual(["converse", "suggest_next"]);
    expect(rows[0]?.calls).toBe(601);
    expect(rows.reduce((sum, row) => sum + (row.share ?? 0), 0)).toBeCloseTo(1, 5);
  });

  test("an unknown purpose, or none, is 'other' — named, never dropped", () => {
    expect(flowOrigin("some_future_flow")).toBe("other");
    expect(flowOrigin("")).toBe("other");
    expect(flowOrigin("critic_preview")).toBe("authoring");
    expect(flowOrigin("toString")).toBe("other");
    const rows = originRows({
      groups: [flow("converse", 10, 1), flow("some_future_flow", 5, 0.5), flow("", 5, 0.5)],
    });
    const other = rows.find((row) => row.key === "other");
    expect(other).toMatchObject({ tokens: 10, cost: 1 });
    expect([...(other?.flows ?? [])].sort()).toEqual(["", "some_future_flow"]);
  });

  test("one flow without an amount makes its origin's amount unknown, not a partial sum", () => {
    const rows = originRows({ groups: [flow("generate", 10, 1), flow("repair", 10, null)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost).toBeNull();
    expect(rows[0]?.share).toBe(1);
  });

  test("survives an envelope it does not recognise", () => {
    for (const bad of [null, undefined, {}, { groups: "nope" }])
      expect(originRows(bad)).toEqual([]);
  });
});

describe("the workflows a run can be named for", () => {
  test("drop the catch-all of calls without a run, and keep their share of the whole window", () => {
    const rows = consumptionRows(
      {
        groups: [
          { key: { workflow: "" }, totals: { calls: 600, tokens: { total: 970 } } },
          { key: { workflow: "w1" }, totals: { calls: 3, tokens: { total: 30 } } },
        ],
      },
      "workflow",
    );
    const attributed = attributableWorkflowRows(rows);
    expect(attributed.map((row) => row.key)).toEqual(["w1"]);
    expect(attributed[0]?.share).toBeCloseTo(0.03, 5);
    expect(attributableWorkflowRows(rows.filter((row) => row.unattributed))).toEqual([]);
  });
});

describe("merging one model price into the stored list", () => {
  test("keeps the other models and appends the edited one", () => {
    expect(
      mergeModelPrice([{ model: "alfa", input_per_mtok: 1, output_per_mtok: 2 }], "beta", 3, 4),
    ).toEqual([
      { model: "alfa", input_per_mtok: 1, output_per_mtok: 2 },
      { model: "beta", input_per_mtok: 3, output_per_mtok: 4 },
    ]);
  });

  test("replaces an earlier price of the same model", () => {
    expect(
      mergeModelPrice(
        [
          { model: "beta", input_per_mtok: 1, output_per_mtok: 1 },
          { model: "alfa", input_per_mtok: 5, output_per_mtok: 6 },
        ],
        "beta",
        3,
        4,
      ),
    ).toEqual([
      { model: "alfa", input_per_mtok: 5, output_per_mtok: 6 },
      { model: "beta", input_per_mtok: 3, output_per_mtok: 4 },
    ]);
  });

  test("a missing or malformed list starts empty", () => {
    expect(mergeModelPrice(null, "beta", 3, 4)).toEqual([
      { model: "beta", input_per_mtok: 3, output_per_mtok: 4 },
    ]);
  });
});

describe("the prompt cache of a conversation", () => {
  test("reads the cache share over the calls whose provider reported cache figures", () => {
    const [group] = llmGroups({
      groups: [
        {
          key: { conversation: "c1" },
          totals: {
            calls: 4,
            tokens: { prompt: 4000, cache_read: 1500 },
            prompt_cache: {
              reported_calls: 3,
              reported_prompt_tokens: 3000,
              reported_cache_read_tokens: 1500,
              hit_percent: 50,
            },
          },
        },
      ],
    });
    expect(group?.promptCache).toEqual({ hit: 0.5, cachedTokens: 1500, reportedCalls: 3 });
  });

  test("has no share when no provider reported cache figures", () => {
    expect(
      promptCacheOf({
        reported_calls: 0,
        reported_prompt_tokens: 0,
        reported_cache_read_tokens: 0,
        hit_percent: null,
      }),
    ).toEqual({ hit: null, cachedTokens: 0, reportedCalls: 0 });
    expect(promptCacheOf(undefined)).toEqual({ hit: null, cachedTokens: 0, reportedCalls: 0 });
  });
});
