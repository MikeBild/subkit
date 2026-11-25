import { describe, expect, it } from "bun:test";
import { cacheReadReported } from "./cache-reporting.ts";

describe("cacheReadReported", () => {
  it("distinguishes missing SDK cache usage from explicit zero", () => {
    expect(cacheReadReported(undefined)).toBe(false);
    expect(cacheReadReported({})).toBe(false);
    expect(cacheReadReported({ raw: "unknown" })).toBe(false);
    expect(cacheReadReported({ inputTokenDetails: {} })).toBe(false);
    expect(cacheReadReported({ inputTokenDetails: { cacheReadTokens: null } })).toBe(false);
    expect(cacheReadReported({ inputTokenDetails: { cacheReadTokens: 0 } })).toBe(true);
    expect(cacheReadReported({ raw: {}, inputTokenDetails: { cacheReadTokens: 12 } })).toBe(true);
  });

  it("uses raw provider reporting instead of normalized SDK defaults", () => {
    for (const raw of [{ prompt_tokens: 100 }, { input_tokens: 100 }]) {
      expect(cacheReadReported({ raw, inputTokenDetails: { cacheReadTokens: 0 } })).toBe(false);
    }
  });

  it("recognizes explicit cache counts in each raw provider shape", () => {
    for (const cached of [0, 12]) {
      for (const raw of [
        { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: cached } },
        { input_tokens: 100, input_tokens_details: { cached_tokens: cached } },
        { input_tokens: 100, cache_read_input_tokens: cached },
      ]) {
        expect(cacheReadReported({ raw })).toBe(true);
      }
    }
  });

  it("treats null and absent raw cache counts as unreported", () => {
    for (const raw of [
      { prompt_tokens: 100, prompt_tokens_details: {} },
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: null } },
      { input_tokens: 100, input_tokens_details: { cached_tokens: null } },
      { input_tokens: 100, cache_read_input_tokens: null },
    ]) {
      expect(cacheReadReported({ raw })).toBe(false);
    }
  });
});
