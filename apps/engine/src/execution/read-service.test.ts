import { describe, expect, test } from "bun:test";
import { runCacheReadPct } from "./read-service.ts";

describe("runCacheReadPct", () => {
  test("measures cache reads against the prompt total that already contains them", () => {
    expect(
      runCacheReadPct({ reported_calls: 1, reported_prompt_tokens: 1000, cache_read_tokens: 400 }),
    ).toBe(40);
  });

  test("rounds to one decimal", () => {
    expect(
      runCacheReadPct({ reported_calls: 2, reported_prompt_tokens: 300, cache_read_tokens: 100 }),
    ).toBe(33.3);
  });

  test("is null when no call of the run reported cache figures", () => {
    expect(
      runCacheReadPct({ reported_calls: 0, reported_prompt_tokens: 0, cache_read_tokens: 0 }),
    ).toBeNull();
  });

  test("is null when the reporting calls had no prompt tokens", () => {
    expect(
      runCacheReadPct({ reported_calls: 1, reported_prompt_tokens: 0, cache_read_tokens: 0 }),
    ).toBeNull();
  });
});
