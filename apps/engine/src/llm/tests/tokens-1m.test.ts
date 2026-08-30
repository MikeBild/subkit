// Pins the 1M-context cap matcher in tokens.ts. The Anthropic
// `anthropic-beta: context-1m-2025-08-07` header is already attached
// in `llm/core/model-init.ts:resolveAnthropic`. This test ensures
// `contextCapFor` actually opens the 900k usable budget so the
// assembler stops evicting skills and docs unnecessarily.
//
// Trigger paths verified here:
//   - model id ends in `-1m`
//   - default Claude cap (180k) when neither trigger fires
// Runtime `llm.context_1m` read-back is covered by consumer-readback.test.ts.

import { describe, expect, test } from "bun:test";
import { contextCapFor } from "../accounting/index.ts";

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
});

describe("contextCapFor · open-weight / OpenAI-compatible families", () => {
  test("128k-class open-weight families cap conservatively at ~120k", () => {
    expect(contextCapFor("qwen-3.6-27b")).toBe(120_000);
    expect(contextCapFor("qwen-3-32b")).toBe(120_000);
    expect(contextCapFor("glm-4.6")).toBe(120_000);
    expect(contextCapFor("deepseek-v3")).toBe(120_000);
    expect(contextCapFor("gpt-oss-120b")).toBe(120_000);
    expect(contextCapFor("llama-3.3-70b")).toBe(120_000);
  });

  test("mistral/ministral instruct families cap at 110k", () => {
    expect(contextCapFor("ministral-8b-instruct")).toBe(110_000);
    expect(contextCapFor("mistral-large")).toBe(110_000);
    expect(contextCapFor("mixtral-8x7b")).toBe(110_000);
  });

  test("anchors on the leading family — a merge id does not collide", () => {
    // `includes("mixtral")` would mis-bucket this to 110k; startsWith on the
    // bare id resolves it to the leading `llama` family (120k).
    expect(contextCapFor("llama-mixtral-8x22b")).toBe(120_000);
  });

  test("matches the bare last segment of slash-namespaced ids", () => {
    expect(contextCapFor("vendor/qwen-3-32b")).toBe(120_000);
    expect(contextCapFor("together/llama-3.3-70b")).toBe(120_000);
  });

  test("unknown ids keep the conservative 100k default", () => {
    expect(contextCapFor("some-unknown-model")).toBe(100_000);
  });
});
