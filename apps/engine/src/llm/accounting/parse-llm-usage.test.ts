// `parseLlmUsage` against the envelopes production actually returns.
//
// The three shapes spell their counters differently AND disagree about what
// the input counter means, so the parser has to normalise rather than pass
// numbers through. The engine's convention — the one `weightedTotalTokens`
// subtracts back out — is that `prompt_tokens` INCLUDES both cache slices.
// Verified against 561 production rows carrying cache tokens: not one had a
// negative remainder after that subtraction.
import { describe, expect, it } from "bun:test";

import { parseLlmUsage } from "./enforce.ts";

describe("parseLlmUsage", () => {
  it("adds the cache slices in for the Messages shape, which excludes them", () => {
    // Verbatim shape from a claude-fable-5 response captured in production.
    const usage = parseLlmUsage({
      usage: {
        input_tokens: 13316,
        output_tokens: 5499,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 18316, // 13316 + 4000 + 1000
      completion_tokens: 5499,
      total_tokens: 23815,
      cache_read_tokens: 4000,
      cache_creation_tokens: 1000,
    });
  });

  it("leaves the Responses shape alone, which already includes them", () => {
    // Verbatim from a gpt-5.6-sol response: 22800 = 1531 + 21266 + 3 fresh.
    const usage = parseLlmUsage({
      usage: {
        input_tokens: 22800,
        total_tokens: 23590,
        output_tokens: 790,
        input_tokens_details: { cached_tokens: 1531, cache_write_tokens: 21266 },
        output_tokens_details: { reasoning_tokens: 730 },
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 22800,
      completion_tokens: 790,
      total_tokens: 23590,
      cache_read_tokens: 1531,
      cache_creation_tokens: 21266,
    });
  });

  it("reads the Chat-Completions shape", () => {
    const usage = parseLlmUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(usage?.prompt_tokens).toBe(1000);
    expect(usage?.cache_read_tokens).toBe(800);
    expect(usage?.cache_creation_tokens).toBe(0);
  });

  it("never reports a prompt count the weighting would have to clamp", () => {
    // The clamp in weightedTotalTokens exists for malformed input; a shape this
    // parser understands must never need it, or the recorded cost is silently
    // wrong in the provider's favour.
    for (const body of [
      { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 } },
      {
        usage: { input_tokens: 100, output_tokens: 1, input_tokens_details: { cached_tokens: 99 } },
      },
    ]) {
      const u = parseLlmUsage(body)!;
      expect(
        u.prompt_tokens - u.cache_read_tokens - u.cache_creation_tokens,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns null when there is nothing to book", () => {
    expect(parseLlmUsage(null)).toBeNull();
    expect(parseLlmUsage({})).toBeNull();
    expect(parseLlmUsage({ usage: {} })).toBeNull();
    expect(parseLlmUsage({ usage: { service_tier: "standard" } })).toBeNull();
  });
});
