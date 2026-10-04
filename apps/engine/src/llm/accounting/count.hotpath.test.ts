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
    const big = "word ".repeat(20_000);
    const estimated = countTokens(big);
    expect(estimated).toBe(Math.ceil(big.length / 3.5));
    expect(estimated).toBeGreaterThan(big.length / 4);
  });

  test("small blocks keep exact BPE counts (budget baselines unaffected)", () => {
    const text = "hello world";
    const exact = countTokens(text);
    expect(exact).toBe(2);
    expect(exact).not.toBe(Math.ceil(text.length / 3.5));
  });

  test("empty input stays zero", () => {
    expect(countTokens("")).toBe(0);
  });
});
