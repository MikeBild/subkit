import { expect, test } from "bun:test";
import { weekSummary } from "./workflow-runs";

test("the week total stands even when the failed count is missing", () => {
  expect(weekSummary(undefined, 2)).toBeNull();
  expect(weekSummary(4, undefined)).toEqual({
    key: "workflowRuns.weekTotal.other",
    values: { count: 4 },
  });
  expect(weekSummary(1, undefined)?.key).toBe("workflowRuns.weekTotal.one");
  expect(weekSummary(4, 1)).toEqual({
    key: "workflowRuns.week.other",
    values: { count: 4, failed: 1 },
  });
});
