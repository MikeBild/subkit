import { describe, expect, test } from "bun:test";
import { llmStatsQuery, windowBounds } from "@/features/usage/model/operations-figures";
import {
  BREAKDOWN_AXIS,
  BREAKDOWN_DIMS,
  breakdown,
  breakdownDims,
  CONSUMPTION_AXES,
  isBreakdownDim,
  llmWindow,
} from "@/features/usage/model/usage-model";
import { CATALOGS, LOCALES } from "@/lib/i18n";

const envelope = (groups: unknown[]) => ({
  totals: { calls: { total: 10, by_result: {} }, tokens: { prompt: 0, total: 1000 } },
  cost: { amount: 10, currency: "USD", unpriced_calls: 0, cache_savings: 0 },
  groups,
});

const group = (task: string, calls: number, cost: number) => ({
  key: { task },
  totals: { calls, tokens: { prompt: 0, total: cost * 100 }, latency_ms: { p50: 1 }, result: {} },
  cost: { amount: cost, currency: "USD", unpriced_calls: 0, cache_savings: 0 },
  buckets: [],
});

describe("usage broken down by task", () => {
  test("the task dimension asks the engine to group by task", () => {
    expect(BREAKDOWN_DIMS).toContain("task");
    expect(isBreakdownDim("task")).toBe(true);
    expect(BREAKDOWN_AXIS.task).toBe("task");
    expect(CONSUMPTION_AXES).toContain("task");
    const bounds = windowBounds("thisMonth", new Date(2026, 10, 19, 12, 0));
    expect(llmStatsQuery(bounds, BREAKDOWN_AXIS.task).group_by).toBe("task");
  });

  test("calls outside any task run are the one remainder row", () => {
    const window = llmWindow(envelope([]));
    if (!window) throw new Error("window fixture");
    const result = breakdown(
      envelope([group("t-small", 2, 2), group("t-big", 5, 5), group("", 3, 3)]),
      "task",
      window,
      envelope([group("t-big", 5, 2.5)]),
    );
    expect(result.rows.map((row) => row.key)).toEqual(["t-big", "t-small"]);
    expect(result.rows[0]?.trend).toEqual({ kind: "more", percent: 100 });
    expect(result.rows[1]?.trend).toEqual({ kind: "new" });
    expect(result.remainder).toEqual({ cost: 3, calls: 3, share: 0.3 });
  });

  test("the breakdown covers every owner's tasks, so it needs both rights", () => {
    expect(breakdownDims(["stats:read"])).toEqual(["workflow", "model"]);
    expect(breakdownDims(["stats:read", "stats:read:all"])).toEqual([
      "workflow",
      "person",
      "model",
      "conversation",
    ]);
    expect(breakdownDims(["stats:read", "task:read"])).toEqual(["workflow", "model"]);
    expect(breakdownDims(["stats:read:all", "task:read"])).toEqual([
      "workflow",
      "person",
      "model",
      "conversation",
      "task",
    ]);
  });

  test("the dimension, its remainder and a deleted task have words in both languages", () => {
    expect(CATALOGS.de["usage.axis.task"]).toBe("Aufgabe");
    expect(CATALOGS.en["usage.axis.task"]).toBe("Task");
    for (const locale of LOCALES)
      for (const key of ["usage.remainder.task", "usage.taskGone"] as const)
        expect(CATALOGS[locale][key].trim()).not.toBe("");
  });
});
