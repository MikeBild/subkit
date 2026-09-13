// Unit tests for the LLM-judge harness. The harness must:
//   - stay disabled when SUBKIT_EVAL_LLM_JUDGE is unset,
//   - only invoke when validator says (pass=false, function_passed=true),
//   - parse judge output deterministically into a structured verdict.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { invokeJudge, judgeEnabled, parseJudgeResponse, shouldInvokeJudge } from "../llm-judge.ts";

describe("llm-judge", () => {
  const original = process.env.SUBKIT_EVAL_LLM_JUDGE;

  beforeEach(() => {
    process.env.SUBKIT_EVAL_LLM_JUDGE = "1";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SUBKIT_EVAL_LLM_JUDGE;
    else process.env.SUBKIT_EVAL_LLM_JUDGE = original;
  });

  test("judgeEnabled tracks the env flag", () => {
    expect(judgeEnabled()).toBe(true);
    delete process.env.SUBKIT_EVAL_LLM_JUDGE;
    expect(judgeEnabled()).toBe(false);
  });

  test("shouldInvokeJudge fires only on (pass=false, function_passed=true)", () => {
    expect(shouldInvokeJudge({ pass: false, function_passed: true })).toBe(true);
    expect(shouldInvokeJudge({ pass: true, function_passed: true })).toBe(false);
    expect(shouldInvokeJudge({ pass: false, function_passed: false })).toBe(false);
  });

  test("shouldInvokeJudge respects the env flag", () => {
    delete process.env.SUBKIT_EVAL_LLM_JUDGE;
    expect(shouldInvokeJudge({ pass: false, function_passed: true })).toBe(false);
  });

  test("parseJudgeResponse picks the correct verdict from the first line", () => {
    expect(parseJudgeResponse("passes\nlooks good").judgment).toBe("passes");
    expect(parseJudgeResponse("partial\nclose but off").judgment).toBe("partial");
    expect(parseJudgeResponse("failed\nwrong").judgment).toBe("failed");
  });

  test("parseJudgeResponse falls back to partial on garbled output", () => {
    expect(parseJudgeResponse("hmm not sure").judgment).toBe("partial");
  });

  test("parseJudgeResponse caps the reasoning at 500 chars", () => {
    const long = `failed\n${"x".repeat(2_000)}`;
    expect(parseJudgeResponse(long).reason.length).toBe(500);
  });

  test("invokeJudge surfaces the verdict from a custom provider", async () => {
    const provider = async () => "passes\nthe outputs match semantically";
    const result = await invokeJudge(
      {
        fixture_name: "demo",
        flow: "converse",
        input: { ask: "x" },
        expected: { ok: true },
        observed: { ok: true },
      },
      provider,
    );
    expect(result.judgment).toBe("passes");
    expect(result.reason).toContain("match");
  });
});
