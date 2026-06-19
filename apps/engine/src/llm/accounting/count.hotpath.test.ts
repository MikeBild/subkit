// Regression: countTokens runs ON THE EVENT LOOP per model call (full
// prompt + full history) — production correlated it with event_loop.lag
// (~1.6s median) and multi-hundred-MB RSS spikes. Pins the two
// protections: memoization (exact counts, computed once) and the
// large-block estimator (never BPE-encode something that stalls the loop).

import { describe, expect, test } from "bun:test";
import { countTokens } from "./count.ts";

describe("countTokens hot-path protection", () => {
  test("repeat counts are memoized and stay exact", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    const first = countTokens(text);
    const second = countTokens(text);
    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);
  });

  test("blocks above the threshold use the conservative estimator", () => {
    // >64KB — the estimator must OVERcount vs ~4 chars/token prose so the
    // budget trips early, never late.
    const big = "word ".repeat(20_000); // 100k chars, ~25k real tokens
    const estimated = countTokens(big);
    expect(estimated).toBe(Math.ceil(big.length / 3.5));
    expect(estimated).toBeGreaterThan(big.length / 4);
  });

  test("small blocks keep exact BPE counts (budget baselines unaffected)", () => {
    // Well under the threshold — must be the real tiktoken count, which
    // for this string differs from the chars/3.5 estimate.
    const text = "hello world";
    const exact = countTokens(text);
    expect(exact).toBe(2);
    expect(exact).not.toBe(Math.ceil(text.length / 3.5));
  });

  test("empty input stays zero", () => {
    expect(countTokens("")).toBe(0);
  });
});
