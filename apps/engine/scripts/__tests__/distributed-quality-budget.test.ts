import { expect, test } from "bun:test";
import { deriveDistributedBaselineBudget } from "../audit/distributed-quality-budget.ts";

test("budgets the complete serial baseline independently of campaign duration", () => {
  expect(
    deriveDistributedBaselineBudget(
      ["a", "b"],
      [
        { test: "a", durationMs: 100_000 },
        { test: "b", durationMs: 200_000 },
      ],
    ),
  ).toEqual({
    baseline_budget_ms: 510_000,
    measured_ms: 300_000,
    measured_files: 2,
    guarded_files: 0,
  });
});

test("unmeasured direct tests retain the complete process and termination allowance", () => {
  expect(
    deriveDistributedBaselineBudget(
      ["direct", "behavior"],
      [
        { test: "behavior", durationMs: 10_000 },
        { test: "other-shard", durationMs: 999_999 },
      ],
    ),
  ).toEqual({
    baseline_budget_ms: 230_000,
    measured_ms: 10_000,
    measured_files: 1,
    guarded_files: 1,
  });
});

test("rejects ambiguous or invalid timing evidence", () => {
  expect(() => deriveDistributedBaselineBudget([], [])).toThrow();
  expect(() => deriveDistributedBaselineBudget(["a", "a"], [])).toThrow();
  expect(() => deriveDistributedBaselineBudget(["a"], [{ test: "a", durationMs: -1 }])).toThrow();
  expect(() =>
    deriveDistributedBaselineBudget(
      ["a"],
      [
        { test: "a", durationMs: 1 },
        { test: "a", durationMs: 2 },
      ],
    ),
  ).toThrow();
});
