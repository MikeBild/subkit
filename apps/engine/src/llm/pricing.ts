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
