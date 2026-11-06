import { describe, expect, test } from "bun:test";
import { compareBudgets, parseBudgets, renderBudgets, shrinkBudgets } from "../audit/budgets.ts";

describe("parseBudgets", () => {
  test("reads path and budget, skips comments and blank lines", () => {
    const text = ["# header", "", "a.ts  700", "b.ts 3  # reason", "c.ts"].join("\n");
    expect([...parseBudgets(text)]).toEqual([
      ["a.ts", 700],
      ["b.ts", 3],
      ["c.ts", Number.POSITIVE_INFINITY],
    ]);
  });

  test("round-trips what renderBudgets writes", () => {
    const offenders = new Map([
      ["z/long-name.ts", 912],
      ["a.ts", 2],
    ]);
    const text = renderBudgets(["Rule: x."], offenders);
    expect(text.startsWith("# Rule: x.\n\na.ts            2\n")).toBe(true);
    expect([...parseBudgets(text)]).toEqual([
      ["a.ts", 2],
      ["z/long-name.ts", 912],
    ]);
  });
});

describe("compareBudgets", () => {
  test("fails unlisted and grown files, reports stale entries", () => {
    const report = compareBudgets(
      new Map([
        ["new.ts", 1],
        ["grown.ts", 650],
        ["same.ts", 700],
        ["shrunk.ts", 610],
      ]),
      new Map([
        ["grown.ts", 640],
        ["same.ts", 700],
        ["shrunk.ts", 900],
        ["fixed.ts", 4],
      ]),
    );
    expect(report).toEqual({
      unlisted: [{ path: "new.ts", measure: 1 }],
      grown: [{ path: "grown.ts", measure: 650, budget: 640 }],
      stale: ["fixed.ts"],
    });
  });

  test("passes an empty tree against an empty allowlist", () => {
    expect(compareBudgets(new Map(), new Map())).toEqual({ unlisted: [], grown: [], stale: [] });
  });
});

describe("shrinkBudgets", () => {
  const budgets = new Map([
    ["grown.ts", 640],
    ["shrunk.ts", 900],
    ["fixed.ts", 4],
  ]);
  const offenders = new Map([
    ["grown.ts", 650],
    ["shrunk.ts", 610],
    ["new.ts", 2],
  ]);

  test("lowers budgets to the measure, never raises them, drops fixed files and rejects new ones", () => {
    expect([...shrinkBudgets(budgets, offenders, false)]).toEqual([
      ["grown.ts", 640],
      ["shrunk.ts", 610],
    ]);
  });

  test("admits new offenders only when asked", () => {
    expect([...shrinkBudgets(budgets, offenders, true)]).toEqual([
      ["grown.ts", 640],
      ["shrunk.ts", 610],
      ["new.ts", 2],
    ]);
  });
});
