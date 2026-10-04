import { describe, expect, test } from "bun:test";
import { type PricedTokens, priceCalls, type SourcedModelPrice } from "../pricing.ts";

const SONNET: SourcedModelPrice = {
  model: "claude-sonnet-4-6",
  input_per_mtok: 3,
  output_per_mtok: 15,
  cache_read_per_mtok: 0.3,
  cache_write_per_mtok: 3.75,
  price_source: "override",
};

const call = (over: Partial<PricedTokens> = {}): PricedTokens => ({
  model: "claude-sonnet-4-6",
  prompt_tokens: 1_000_000,
  completion_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  ...over,
});

describe("pricing a set of calls", () => {
  test("charges input, output and both cache rates at their own price", () => {
    const result = priceCalls(
      [call({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })],
      [SONNET],
      "USD",
    );
    expect(result.amount).toBeCloseTo(18, 6);
  });

  test("does not charge cached tokens at the input rate", () => {
    const result = priceCalls(
      [call({ prompt_tokens: 1_000_000, cache_read_tokens: 1_000_000 })],
      [SONNET],
      "USD",
    );
    expect(result.amount).toBeCloseTo(0.3, 6);
  });

  test("a cache write costs more than a plain input token", () => {
    const written = priceCalls(
      [call({ prompt_tokens: 1_000_000, cache_creation_tokens: 1_000_000 })],
      [SONNET],
      "USD",
    );
    expect(written.amount).toBeCloseTo(3.75, 6);
  });

  test("an unpriced model is named, not counted as free", () => {
    const result = priceCalls(
      [call(), call({ model: "some-new-model" }), call({ model: "some-new-model" })],
      [SONNET],
      "USD",
    );
    expect(result.amount).toBeCloseTo(3, 6);
    expect(result.unpriced_models).toEqual(["some-new-model"]);
    expect(result.unpriced_calls).toBe(2);
  });

  test("with no rates at all the amount is zero AND every call is declared unpriced", () => {
    const result = priceCalls([call(), call()], [], "USD");
    expect(result.amount).toBe(0);
    expect(result.unpriced_calls).toBe(2);
    expect(result.unpriced_models).toEqual(["claude-sonnet-4-6"]);
  });

  test("names the basis it computed on", () => {
    expect(priceCalls([], [], "EUR").rates_basis).toBe("current");
    expect(priceCalls([], [], "EUR").currency).toBe("EUR");
  });

  test("keeps small real amounts instead of rounding them to nothing", () => {
    const result = priceCalls([call({ prompt_tokens: 1_000 })], [SONNET], "USD");
    expect(result.amount).toBeGreaterThan(0);
    expect(result.amount).toBeCloseTo(0.003, 6);
  });

  test("a prompt smaller than its own cache counters never goes negative", () => {
    const result = priceCalls(
      [call({ prompt_tokens: 10, cache_read_tokens: 1_000_000 })],
      [SONNET],
      "USD",
    );
    expect(result.amount).toBeGreaterThanOrEqual(0);
  });
});

describe("aggregated rows", () => {
  test("an unpriced row stands for every call it covers, not for one", () => {
    const result = priceCalls([call({ model: "unknown-model", calls: 2_000 })], [SONNET], "USD");
    expect(result.unpriced_calls).toBe(2_000);
  });

  test("a row without a call count still counts as one", () => {
    expect(priceCalls([call({ model: "unknown-model" })], [], "USD").unpriced_calls).toBe(1);
  });
});
