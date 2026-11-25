import { describe, expect, test } from "bun:test";
import { isAbortError, readStepUsage, stepPromptTokens, stepTotalTokens } from "./usage.ts";

describe("readStepUsage", () => {
  test("zeros out missing usage fields", () => {
    expect(readStepUsage({ usage: {} })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheReported: false,
    });
  });

  test("preserves omitted cache reporting through SDK normalization", () => {
    for (const raw of [
      { prompt_tokens: 10, completion_tokens: 2 },
      { input_tokens: 10, output_tokens: 2 },
    ]) {
      expect(
        readStepUsage({
          usage: { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 0 }, raw },
        }).cacheReported,
      ).toBe(false);
    }
  });

  test("marks an explicitly reported zero cache read as reported", () => {
    expect(
      readStepUsage({ usage: { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 0 } } })
        .cacheReported,
    ).toBe(true);
  });

  test("reads unified usage when present", () => {
    expect(
      readStepUsage({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheCreationTokens: 10,
      cacheReported: true,
    });
  });

  test("falls back to providerMetadata.anthropic.usage for cache tokens", () => {
    expect(
      readStepUsage({
        usage: { inputTokens: 100, outputTokens: 50 },
        providerMetadata: {
          anthropic: {
            usage: {
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 10,
            },
          },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheCreationTokens: 10,
      cacheReported: true,
    });
  });

  test("prefers unified usage over Anthropic fallback when both present", () => {
    expect(
      readStepUsage({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
        },
        providerMetadata: {
          anthropic: {
            usage: { cache_read_input_tokens: 999, cache_creation_input_tokens: 999 },
          },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 80,
      cacheCreationTokens: 10,
      cacheReported: true,
    });
  });
});

describe("stepPromptTokens / stepTotalTokens", () => {
  test("prompt size is the SDK input total, which already includes cache reads and writes", () => {
    expect(
      stepPromptTokens({
        inputTokens: 173_000,
        outputTokens: 50,
        cacheReadTokens: 170_000,
        cacheCreationTokens: 2000,
      }),
    ).toBe(173_000);
  });

  test("prompt size never falls below the reported cache figures", () => {
    expect(
      stepPromptTokens({
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 170_000,
        cacheCreationTokens: 2000,
      }),
    ).toBe(172_000);
  });

  test("total adds completion tokens on top of the prompt", () => {
    expect(
      stepPromptTokens({
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(100);
    expect(
      stepTotalTokens({
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(140);
  });

  test("sum vs last-call: accumulating steps the way the loop does", () => {
    const steps = [
      { inputTokens: 18_000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 8000 },
      { inputTokens: 20_000, outputTokens: 700, cacheReadTokens: 18_000, cacheCreationTokens: 0 },
      { inputTokens: 23_000, outputTokens: 900, cacheReadTokens: 20_000, cacheCreationTokens: 0 },
    ];
    let promptTokensLastCall: number | null = null;
    let turnTokensTotal = 0;
    for (const u of steps) {
      promptTokensLastCall = stepPromptTokens(u);
      turnTokensTotal += stepTotalTokens(u);
    }
    expect(promptTokensLastCall).toBe(23_000);
    expect(turnTokensTotal).toBe(18_500 + 20_700 + 23_900);
    expect(turnTokensTotal).toBeGreaterThan(promptTokensLastCall ?? 0);
  });
});

describe("isAbortError", () => {
  test("recognises DOMException AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  test("recognises DOMException TimeoutError", () => {
    expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  test("recognises Error with abort/cancel in the message", () => {
    expect(isAbortError(new Error("connection aborted"))).toBe(true);
    expect(isAbortError(new Error("operation cancelled"))).toBe(true);
  });

  test("recognises string with abort/cancel", () => {
    expect(isAbortError("the request was cancelled")).toBe(true);
  });

  test("rejects provider strings where the cancel/abort token is INSIDE another word", () => {
    expect(isAbortError(new Error("provider has a cancellation policy"))).toBe(false);
    expect(isAbortError("operation cannot be cancellation-policy gated")).toBe(false);
  });

  test("still recognises the standalone token forms thrown by SDKs", () => {
    expect(isAbortError(new Error("aborted"))).toBe(true);
    expect(isAbortError(new Error("operation was cancelled"))).toBe(true);
    expect(isAbortError(new Error("operation was canceled"))).toBe(true);
    expect(isAbortError("aborted upstream")).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isAbortError(new Error("something else"))).toBe(false);
    expect(isAbortError(new DOMException("oops", "InvalidStateError"))).toBe(false);
    expect(isAbortError("some other message")).toBe(false);
  });

  test("does NOT match the underscore-prefixed conversation_cancelled reason", () => {
    expect(isAbortError("conversation_cancelled")).toBe(false);
    expect(isAbortError(new Error("conversation_cancelled"))).toBe(false);
  });
});
