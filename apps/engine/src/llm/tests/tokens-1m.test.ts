// Pins the 1M-context cap matcher in tokens.ts. The Anthropic
// `anthropic-beta: context-1m-2025-08-07` header is already attached
// in `llm/core/model-init.ts:resolveAnthropic`. This test ensures
// `contextCapFor` actually opens the 900k usable budget so the
// assembler stops evicting skills and docs unnecessarily.
//
// Three trigger paths verified:
//   - model id ends in `-1m`
//   - env LLM_CONTEXT_1M=1
//   - default Claude cap (180k) when neither trigger fires

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { contextCapFor } from "../accounting/index.ts";

let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.LLM_CONTEXT_1M;
  delete process.env.LLM_CONTEXT_1M;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.LLM_CONTEXT_1M;
  } else {
    process.env.LLM_CONTEXT_1M = originalEnv;
  }
});

describe("contextCapFor · 1M Claude cap", () => {
  test("default Claude (sonnet/opus/haiku) caps at 180k", () => {
    expect(contextCapFor("claude-sonnet-4-6")).toBe(180_000);
    expect(contextCapFor("claude-opus-4-7")).toBe(180_000);
    expect(contextCapFor("claude-haiku-4-5")).toBe(180_000);
  });

  test("model id ending in `-1m` lifts cap to 900k", () => {
    expect(contextCapFor("claude-sonnet-4-6-1m")).toBe(900_000);
    expect(contextCapFor("claude-opus-4-7-1m")).toBe(900_000);
    expect(contextCapFor("claude-haiku-4-5-1m")).toBe(900_000);
  });

  test("model id with explicit beta tag lifts cap to 900k", () => {
    expect(contextCapFor("claude-sonnet-4-6-1m-2025-08-07")).toBe(900_000);
  });

  test("env LLM_CONTEXT_1M=1 lifts every Claude id to 900k", () => {
    process.env.LLM_CONTEXT_1M = "1";
    expect(contextCapFor("claude-sonnet-4-6")).toBe(900_000);
    expect(contextCapFor("claude-opus-4-7")).toBe(900_000);
  });

  test("env LLM_CONTEXT_1M=1 leaves non-Claude ids unaffected", () => {
    process.env.LLM_CONTEXT_1M = "1";
    expect(contextCapFor("gpt-4o")).toBe(120_000);
    expect(contextCapFor("gpt-4")).toBe(110_000);
    expect(contextCapFor("mock")).toBe(12_000);
  });

  test("env LLM_CONTEXT_1M values other than '1' are ignored", () => {
    process.env.LLM_CONTEXT_1M = "0";
    expect(contextCapFor("claude-sonnet-4-6")).toBe(180_000);
    process.env.LLM_CONTEXT_1M = "true";
    expect(contextCapFor("claude-sonnet-4-6")).toBe(180_000);
  });
});
