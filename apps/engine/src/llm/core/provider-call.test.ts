import { describe, expect, it } from "bun:test";
import {
  estimateLlmCallTokens,
  extractModelHint,
  isLlmProviderHost,
  parseLlmUsage,
} from "./provider-call.ts";

describe("parseLlmUsage", () => {
  it("reads token counts sent as numeric strings", () => {
    expect(
      parseLlmUsage({ usage: { prompt_tokens: "12", completion_tokens: "3", total_tokens: "x" } }),
    ).toMatchObject({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  it("adds the cache slices in for the Messages shape, which excludes them", () => {
    const usage = parseLlmUsage({
      usage: {
        input_tokens: 13316,
        output_tokens: 5499,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1000,
      },
    });
    expect(usage).toEqual({
      prompt_tokens: 18316,
      completion_tokens: 5499,
      total_tokens: 23815,
      cache_read_tokens: 4000,
      cache_creation_tokens: 1000,
    });
  });

  it("leaves the Responses shape alone, which already includes them", () => {
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

describe("isLlmProviderHost", () => {
  it("knows the built-in provider hosts", () => {
    expect(isLlmProviderHost("api.anthropic.com", [])).toBe(true);
    expect(isLlmProviderHost("API.OpenAI.com", [])).toBe(true);
  });

  it("counts configured extra hosts, case and space insensitive", () => {
    expect(isLlmProviderHost("127.0.0.1", [" 127.0.0.1 "])).toBe(true);
    expect(isLlmProviderHost("llm.internal", ["LLM.internal"])).toBe(true);
  });

  it("leaves every other host alone", () => {
    expect(isLlmProviderHost("api.example.com", [])).toBe(false);
    expect(isLlmProviderHost("", [""])).toBe(false);
  });
});

describe("estimateLlmCallTokens", () => {
  it("never estimates below the prompt floor", () => {
    expect(estimateLlmCallTokens(null)).toBe(50);
    expect(estimateLlmCallTokens("hi")).toBe(50);
  });

  it("estimates four characters per token for large bodies", () => {
    expect(estimateLlmCallTokens("x".repeat(400))).toBe(100);
  });

  it("measures an object body as JSON and falls back to the floor when it cannot be serialized", () => {
    expect(estimateLlmCallTokens({ prompt: "x".repeat(400) })).toBe(104);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateLlmCallTokens(circular)).toBe(50);
  });
});

describe("extractModelHint", () => {
  it("prefers the request model, then the response model", () => {
    expect(extractModelHint({ model: "a" }, { model: "b" })).toBe("a");
    expect(extractModelHint({}, { model: "b" })).toBe("b");
    expect(extractModelHint(null, null)).toBe("unknown");
  });
});
