import { expect, test } from "bun:test";
import type { RunResult } from "../../execution/types.ts";
import { sensitiveTestRunSummary } from "./sensitive-dry-run.ts";

const run: RunResult = {
  execution_id: "00000000-0000-4000-8000-0000000005e2",
  status: "succeeded",
  output: null,
  error: null,
  steps: [
    {
      step_key: "loop",
      step_index: 0,
      kind: "for_each",
      status: "succeeded",
      duration_ms: 40,
      retry_count: 0,
      error: null,
    },
    ...[0, 1, 2, 3].map((index) => ({
      step_key: `loop[${index}]`,
      step_index: 0,
      kind: "request",
      status: "succeeded" as const,
      duration_ms: 35,
      retry_count: 0,
      error: null,
      held: true as const,
    })),
  ],
};

test("the run duration is the measured wall-clock time, not the sum of step durations", () => {
  const summary = sensitiveTestRunSummary(run, 42);
  expect(summary.duration_ms).toBe(42);
  expect(summary.counts).toEqual({ total: 5, succeeded: 1, failed: 0, held: 4 });
});
