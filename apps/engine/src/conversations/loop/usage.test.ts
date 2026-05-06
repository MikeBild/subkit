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

  test("known false-positive class: provider strings containing the word 'cancel'", () => {
    // Documented contract: the heuristic IS loose on purpose. A
    // provider error whose message contains "cancellation policy"
    // or similar gets misclassified as abort. We accept that — the
    // alternative (anchored regex) misses real abort cases thrown
    // as strings. This test pins the current behaviour so a future
    // tightening is a deliberate decision, not an accident.
    expect(isAbortError(new Error("provider has a cancellation policy"))).toBe(true);
    expect(isAbortError("operation cannot be cancelled by tenant")).toBe(true);
  });

  test("rejects unrelated errors", () => {
    expect(isAbortError(new Error("something else"))).toBe(false);
    expect(isAbortError(new DOMException("oops", "InvalidStateError"))).toBe(false);
    expect(isAbortError("some other message")).toBe(false);
  });
});
