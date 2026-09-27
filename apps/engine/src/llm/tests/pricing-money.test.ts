// Money from tokens, and an honest account of what could not be priced.
//
// The engine measures tokens and has never known a price: `llm_usage` has no
// monetary column and `pricing.ts` held cache weights, not money. So "what
// does this automation cost" had no answer anywhere in the product.
//
// Rates are applied when a figure is read rather than stored on the ledger, so
// a corrected price corrects every past answer instead of leaving history
// quoted at a rate nobody uses any more.
//
// Every assertion below is about the same failure: an amount that quietly
// leaves calls out looks complete, and a model nobody priced is not free.

import { describe, expect, test } from "bun:test";
import { type ModelPrice, type PricedTokens, priceCalls } from "../pricing.ts";

const SONNET: ModelPrice = {
  model: "claude-sonnet-4-6",
  input_per_mtok: 3,
  output_per_mtok: 15,
  cache_read_per_mtok: 0.3,
  cache_write_per_mtok: 3.75,
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
    expect(result.amount).toBeCloseTo(18, 6); // 3 in + 15 out
  });

  test("does not charge cached tokens at the input rate", () => {
    // The provider's `prompt_tokens` INCLUDES cache reads and writes. Charging
    // the whole prompt at the input rate would bill a cached turn as if it had
    // never been cached — the single most expensive misreading in this data.
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
    // The whole point. A model absent from the table contributes to
    // `unpriced_*` and nothing to `amount`.
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
    // Zero here is only safe because `unpriced_calls` says the zero covers
    // nothing. A surface that shows the amount without that number would be
    // telling an operator their month was free.
    const result = priceCalls([call(), call()], [], "USD");
    expect(result.amount).toBe(0);
    expect(result.unpriced_calls).toBe(2);
    expect(result.unpriced_models).toEqual(["claude-sonnet-4-6"]);
  });

  test("names the basis it computed on", () => {
    // Rates are read-time, so a figure is not a historical invoice and must
    // never be read as one.
    expect(priceCalls([], [], "EUR").rates_basis).toBe("current");
    expect(priceCalls([], [], "EUR").currency).toBe("EUR");
  });

  test("keeps small real amounts instead of rounding them to nothing", () => {
    // Prices run to four decimals per million tokens. Rounding to cents would
    // report a real cost as zero.
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
    // Callers group in SQL and hand this one row per model. Counting that row
    // as a single call would tell an operator two models were unpriced when
    // it was two thousand calls.
    const result = priceCalls([call({ model: "unknown-model", calls: 2_000 })], [SONNET], "USD");
    expect(result.unpriced_calls).toBe(2_000);
  });

  test("a row without a call count still counts as one", () => {
    expect(priceCalls([call({ model: "unknown-model" })], [], "USD").unpriced_calls).toBe(1);
  });
});
