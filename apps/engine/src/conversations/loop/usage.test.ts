// Coverage for per-step usage normalisation, the helper that
// reconciles unified-usage fields with Anthropic's
// providerMetadata.anthropic.usage fallback.

import { describe, expect, test } from "bun:test";
import { isAbortError, readStepUsage, stepPromptTokens, stepTotalTokens } from "./usage.ts";

describe("readStepUsage", () => {
  test("zeros out missing usage fields", () => {
    expect(readStepUsage({ usage: {} })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
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
    });
  });
});

describe("stepPromptTokens / stepTotalTokens", () => {
  // Honest cost telemetry: the `completed` envelope carries
  // `prompt_tokens_last_call` (last step's prompt size — comparable to
  // the context cap) and `turn_tokens_total` (sum across all steps).
  // These helpers are the per-step terms; the loop overwrites the
  // last-call slot and accumulates the total.

  test("prompt size counts uncached input PLUS cache reads and writes", () => {
    // Anthropic's inputTokens EXCLUDES cached prompt tokens — a cache
    // hit must not make the ctx gauge claim a near-empty prompt.
    expect(
      stepPromptTokens({
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 170_000,
        cacheCreationTokens: 2000,
      }),
    ).toBe(173_000);
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
    // Three-step turn with a growing prompt. The loop sets
    // prompt_tokens_last_call to the FINAL step's prompt and
    // turn_tokens_total to the running sum — the two figures the sk
    // footer renders as `ctx <last>/<cap>` and `turn <total>`.
    const steps = [
      { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 8000 },
      { inputTokens: 2000, outputTokens: 700, cacheReadTokens: 18_000, cacheCreationTokens: 0 },
      { inputTokens: 3000, outputTokens: 900, cacheReadTokens: 20_000, cacheCreationTokens: 0 },
    ];
    let promptTokensLastCall: number | null = null;
    let turnTokensTotal = 0;
    for (const u of steps) {
      promptTokensLastCall = stepPromptTokens(u);
      turnTokensTotal += stepTotalTokens(u);
    }
    expect(promptTokensLastCall).toBe(23_000);
    expect(turnTokensTotal).toBe(18_500 + 20_700 + 23_900);
    // The cumulative figure exceeds the last call's prompt — exactly
    // the apples-over-oranges confusion the split envelope resolves.
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
    // The regex is anchored on \b word boundaries, so substrings
    // inside a longer word ("cancellation", "cancellable") do not
    // count. This was the prior loose-regex false-positive class:
    // a real provider error containing "cancellation policy" got
    // misclassified as user abort and the loop swallowed it.
    expect(isAbortError(new Error("provider has a cancellation policy"))).toBe(false);
    expect(isAbortError("operation cannot be cancellation-policy gated")).toBe(false);
  });

  test("still recognises the standalone token forms thrown by SDKs", () => {
    // Word-boundary form: "aborted", "cancelled", "cancel", "abort"
    // all match. The regex covers both UK and US spellings of
    // "cancel(l)ed".
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

  // Pin the underscore-word-boundary blind
  // spot. AI SDK rethrows the AbortController's reason verbatim, and
  // the canonical reason `CONVERSATION_CANCELLED_REASON =
  // "conversation_cancelled"` has an `_` before `cancelled`. Because
  // `_` is a word character in JS regex, the `\b` boundary never
  // triggers — `isAbortError` returns false here. The loop's
  // dispatch-error catch in `apps/engine/src/conversations/loop.ts`
  // falls back to a `signal.reason ===` check; this test pins the
  // blind spot so future readers know the loop's two-way detector
  // is load-bearing.
  test("does NOT match the underscore-prefixed conversation_cancelled reason", () => {
    expect(isAbortError("conversation_cancelled")).toBe(false);
    expect(isAbortError(new Error("conversation_cancelled"))).toBe(false);
  });
});
