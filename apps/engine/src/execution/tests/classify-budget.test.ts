// A run that ran out of allowance is not a broken run.
//
// `llm_quota_exhausted` (the monthly cap, HTTP 429) and `llm_budget_exceeded`
// (a workflow's own `max_llm_tokens_per_run`) both used to classify as
// `driver_error` and read, in the decisions queue and the runs list, exactly
// like a workflow with a bug. An operator sent to look for a defect in a
// workflow that simply ran out of money searches for something that is not
// there — and the real remedy, a budget decision, never gets made.
//
// The ordering matters as much as the class: "llm_quota_exhausted" carries the
// word "exceeded" in its message, which the generic matcher below reads as a
// timeout. Classified late, a money problem would send the reader to look at
// durations.

import { describe, expect, test } from "bun:test";
import { classifyFailure, humanizeClassification } from "../classify.ts";

const step = (code: string, message: string) => ({
  status: "failed" as const,
  retry_count: 0,
  duration_ms: 0,
  error: { code, message },
});

describe("a run that ran out of allowance", () => {
  test("the monthly cap is its own class, not a driver error", () => {
    expect(classifyFailure(step("llm_quota_exhausted", "llm quota exhausted"))).toBe(
      "budget_exhausted",
    );
  });

  test("a run's own token ceiling is the same class", () => {
    expect(classifyFailure(step("llm_budget_exceeded", "run token cap exceeded"))).toBe(
      "budget_exhausted",
    );
  });

  test("is not mistaken for a timeout because its message says 'exceeded'", () => {
    // The generic matcher reads /exceeded/ as a timeout. Classified after it,
    // a money problem would send a reader to look at durations.
    expect(classifyFailure(step("llm_quota_exhausted", "monthly budget exceeded"))).toBe(
      "budget_exhausted",
    );
  });

  test("still classifies a real timeout as one", () => {
    expect(classifyFailure(step("some_code", "the request timed out"))).toBe("timeout");
  });

  test("names the remedy as a budget decision, not a repair", () => {
    const sentence = humanizeClassification("budget_exhausted", "", "request");
    expect(sentence).toMatch(/allowance/i);
    expect(sentence).toMatch(/cap|limit/i);
    // Emphatically not the language of a broken step.
    expect(sentence).not.toMatch(/check the connector|placeholder|data_selector/i);
  });
});
