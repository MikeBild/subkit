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
    expect(sentence).not.toMatch(/check the connector|placeholder|data_selector/i);
  });
});
