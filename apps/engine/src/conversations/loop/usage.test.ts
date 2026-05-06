// Coverage for per-step usage normalisation, the helper that
// reconciles unified-usage fields with Anthropic's
// providerMetadata.anthropic.usage fallback.

import { describe, expect, test } from "bun:test";
import { isAbortError, readStepUsage } from "./usage.ts";

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
});
