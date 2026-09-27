// Cache-weighted token accounting.
//
// Anthropic bills `cache_read_input_tokens` at ~10 % of normal input and
// `cache_creation_input_tokens` at ~125 %. The per-tenant monthly budget
// ledger stores the **effective-cost** weighting in `llm_usage.total_tokens`
// so `sum(total_tokens)` stays a faithful usage signal even when caching
// shifts the mix.
//
// Keep the weights here in one place so adding another provider with a
// different cache pricing model stays a one-line table update.

export interface TokenUsageBreakdown {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** Ratio applied to cache-read tokens when computing effective cost. */
export const CACHE_READ_WEIGHT = 0.1;

/** Ratio applied to cache-creation tokens when computing effective cost. */
export const CACHE_CREATE_WEIGHT = 1.25;

/**
 * Effective-cost total tokens. Non-cached input tokens count at 1.0,
 * completion tokens at 1.0, cache reads at `CACHE_READ_WEIGHT`, cache
 * creations at `CACHE_CREATE_WEIGHT`.
 *
 * Note `prompt_tokens` from the Anthropic usage object **includes** cache
 * reads and creations — we subtract them to get the uncached remainder,
 * then add back the weighted portions.
 */
export function weightedTotalTokens(u: TokenUsageBreakdown): number {
  const uncached = Math.max(0, u.prompt_tokens - u.cache_read_tokens - u.cache_creation_tokens);
  return (
    u.completion_tokens +
    uncached +
    Math.round(u.cache_read_tokens * CACHE_READ_WEIGHT) +
    Math.round(u.cache_creation_tokens * CACHE_CREATE_WEIGHT)
  );
}

// ---------------------------------------------------------------------------
// Money
//
// Tokens are measured; prices are configured. `llm_usage` has no monetary
// column and never gains one: rates are applied when a figure is read, so a
// price change corrects every past answer instead of leaving history quoted at
// a rate nobody uses any more. The cost of that choice is that a figure is
// only as good as the rates in force when it was asked for, which is why every
// answer carries the basis it used.
// ---------------------------------------------------------------------------

export interface ModelPrice {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

export interface PricedTokens extends TokenUsageBreakdown {
  model: string;
}

export interface CostResult {
  /** Money for the rows that had a rate. Never a total that pretends to cover the rest. */
  amount: number;
  currency: string;
  /** Models met without a configured rate, named so a reader can go and set one. */
  unpriced_models: string[];
  /** How many calls those models account for. */
  unpriced_calls: number;
  /** What the figure was computed on, so nobody reads it as a historical invoice. */
  rates_basis: "current";
}

/**
 * Cost of a set of calls, and an honest account of what it could not price.
 *
 * `prompt_tokens` from the provider INCLUDES cache reads and writes, so the
 * uncached remainder is what the input rate applies to — the same subtraction
 * `weightedTotalTokens` makes, for the same reason.
 *
 * A model with no rate contributes to `unpriced_*` and NOT to `amount`. It
 * does not contribute zero: an amount that silently omits half the calls looks
 * complete, which makes it worse than no amount at all.
 */
export function priceCalls(
  calls: readonly PricedTokens[],
  prices: readonly ModelPrice[],
  currency: string,
): CostResult {
  const byModel = new Map(prices.map((p) => [p.model, p]));
  const unpriced = new Map<string, number>();
  let amount = 0;

  for (const call of calls) {
    const rate = byModel.get(call.model);
    if (!rate) {
      unpriced.set(call.model, (unpriced.get(call.model) ?? 0) + 1);
      continue;
    }
    const uncached = Math.max(
      0,
      call.prompt_tokens - call.cache_read_tokens - call.cache_creation_tokens,
    );
    amount +=
      (uncached / 1_000_000) * rate.input_per_mtok +
      (call.completion_tokens / 1_000_000) * rate.output_per_mtok +
      (call.cache_read_tokens / 1_000_000) * rate.cache_read_per_mtok +
      (call.cache_creation_tokens / 1_000_000) * rate.cache_write_per_mtok;
  }

  return {
    // Rounded to the cent-thousandth: model prices run to four decimals per
    // million, and rounding to two would turn a real small number into zero.
    amount: Math.round(amount * 1e6) / 1e6,
    currency,
    unpriced_models: [...unpriced.keys()].sort(),
    unpriced_calls: [...unpriced.values()].reduce((sum, n) => sum + n, 0),
    rates_basis: "current",
  };
}
