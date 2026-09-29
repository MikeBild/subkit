// Cache-weighted token accounting.
//
// Anthropic bills `cache_read_input_tokens` at ~10 % of normal input and
// `cache_creation_input_tokens` at 200 % — the one-hour cache write rate,
// because every cache breakpoint SubKit sets asks for the one-hour TTL
// (`PROMPT_CACHE_TTL` in `core/cache-blocks.ts`). The per-tenant monthly budget
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
export const CACHE_CREATE_WEIGHT = 2;

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

/**
 * The tokens a call is billed for — the one definition every spend reader
 * (cost, conversation usage, execution cost, the monthly budget, stats) sees,
 * because `recordUsage` applies it before the row is written.
 *
 * A call that failed without producing a single output token was not processed
 * by the provider: a refusal (quota, rate limit, auth, context too large) or
 * SubKit's own budget cap turning it away before dispatch. Its prompt figure is
 * the tokenizer's estimate, never a provider-reported count, so it bills
 * nothing. A failure that did produce output was processed and keeps its
 * tokens; so does every success.
 */
export function billedTokenUsage(u: TokenUsageBreakdown & { result: string }): TokenUsageBreakdown {
  if (u.result !== "success" && u.completion_tokens === 0) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
  }
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    cache_read_tokens: u.cache_read_tokens,
    cache_creation_tokens: u.cache_creation_tokens,
  };
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

/**
 * A model id without its provider prefix (`anthropic/claude-…`) or a trailing
 * vendor date stamp (`-20251001`, `-2024-11-20`).
 *
 * This is the vendor's own spelling of the model with nothing but packaging
 * taken off, so a price found through it is the vendor's list price.
 */
export function vendorModelId(modelId: string): string {
  return stripDateStamp(stripProvider(modelId));
}

function stripProvider(id: string): string {
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

function stripDateStamp(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

/**
 * A cloud platform's id for an Anthropic model: Bedrock
 * (`anthropic.claude-haiku-4-5-20251001-v1:0`, optionally behind a
 * `us.`/`eu.`/`apac.`/`global.` inference-profile prefix) or Vertex
 * (`claude-haiku-4-5@20251001`).
 *
 * Anchored on `anthropic.` so a dotted vendor id (`gpt-5.6-sol`,
 * `gemini-2.5-pro`) is never mistaken for one.
 */
const BEDROCK_ID = /^(?:(?:us|eu|apac|global)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/;
const VERTEX_ID = /^(claude-.+)@\d{8}$/;

/**
 * The model id a price is looked up under: `vendorModelId`, and additionally
 * a Bedrock or Vertex id reduced to the Anthropic model it serves.
 *
 * A platform can charge more than the vendor's list price for the same model
 * (Bedrock's regional endpoints do), which is why `priceCalls` reports a rate
 * found only through this reduction as `catalog_normalized`, not `catalog`.
 */
export function bareModelId(modelId: string): string {
  const id = stripProvider(modelId);
  const platform = BEDROCK_ID.exec(id)?.[1] ?? VERTEX_ID.exec(id)?.[1];
  return stripDateStamp(platform ?? id);
}

/**
 * Higher rates a vendor charges for a call whose prompt is longer than a
 * threshold. The whole call is billed at these rates, not only the tokens
 * past the threshold, so the threshold is compared per call.
 */
export interface LongContextPrice {
  /** A call whose prompt (cached tokens included) exceeds this is billed at the rates below. */
  threshold_prompt_tokens: number;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

export interface ModelPrice {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  /** Rates for calls with a prompt past the vendor's long-context threshold, when it has one. */
  long_context?: LongContextPrice;
}

/**
 * Where a rate came from: the built-in catalog under the recorded id (or its
 * vendor spelling), the catalog reached only by reducing a Bedrock or Vertex
 * id to the model it serves, or the operator's `tokens.prices`.
 */
export const PRICE_SOURCES = ["catalog", "catalog_normalized", "override"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** A rate plus where it came from. */
export interface SourcedModelPrice extends ModelPrice {
  price_source: PriceSource;
}

export interface PricedTokens extends TokenUsageBreakdown {
  model: string;
  /**
   * How many provider calls these token sums cover. Defaults to one.
   *
   * Callers aggregate in SQL and hand this function one row per model, so an
   * unpriced row stands for many calls, not one. Without this, an operator
   * would be told two models were unpriced when it was two thousand calls.
   */
  calls?: number;
  /**
   * Every call in this row had a prompt longer than this many tokens.
   *
   * A long-context rate applies per call, so a row of summed tokens cannot
   * decide it: two 150k prompts sum past a 200k threshold without either
   * being long. The row's producer groups calls by the thresholds in force
   * (`longContextThresholds`) and states the bound it knows; a row without
   * it is priced at the base rate unless it is a single call, whose own
   * prompt decides.
   */
  prompt_tokens_exceed?: number;
}

export interface CostResult {
  /** Money for the rows that had a rate. Never a total that pretends to cover the rest. */
  amount: number;
  currency: string;
  /** Models met without a configured rate, named so a reader can go and set one. */
  unpriced_models: string[];
  /** How many calls those models account for. */
  unpriced_calls: number;
  /**
   * Which rate priced each model met, so a reader can tell a built-in list
   * price from one the operator set. Sorted by model.
   */
  price_sources: Array<{ model: string; price_source: PriceSource }>;
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
 * A rate is looked up by the recorded model id first, then by its vendor
 * spelling (provider prefix and date suffix stripped), so `anthropic/claude-…`
 * and a dated snapshot find the base model's price; only then by a Bedrock or
 * Vertex id reduced to its model, which is reported as `catalog_normalized`
 * because a platform may charge more than the vendor lists. An operator who
 * knows the platform's rate sets it under the exact platform id, which wins.
 *
 * A call whose prompt exceeds the rate's long-context threshold is priced at
 * the long-context rates in full — see `PricedTokens.prompt_tokens_exceed`.
 *
 * A model with no rate contributes to `unpriced_*` and NOT to `amount`. It
 * does not contribute zero: an amount that silently omits half the calls looks
 * complete, which makes it worse than no amount at all.
 */
export function priceCalls(
  calls: readonly PricedTokens[],
  prices: readonly SourcedModelPrice[],
  currency: string,
): CostResult {
  const byModel = new Map(prices.map((p) => [p.model, p]));
  const lookup = (model: string): { rate: SourcedModelPrice; source: PriceSource } | undefined => {
    const exact = byModel.get(model) ?? byModel.get(vendorModelId(model));
    if (exact) return { rate: exact, source: exact.price_source };
    const normalized = byModel.get(bareModelId(model));
    if (!normalized) return undefined;
    return {
      rate: normalized,
      source:
        normalized.price_source === "catalog" ? "catalog_normalized" : normalized.price_source,
    };
  };
  const unpriced = new Map<string, number>();
  const sources = new Map<string, PriceSource>();
  let amount = 0;

  for (const call of calls) {
    const found = lookup(call.model);
    if (!found) {
      unpriced.set(call.model, (unpriced.get(call.model) ?? 0) + (call.calls ?? 1));
      continue;
    }
    // One model id always resolves the same way, so its source is one value.
    sources.set(call.model, found.source);
    const rate = (isLongContext(call, found.rate) && found.rate.long_context) || found.rate;
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
    price_sources: [...sources.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([model, price_source]) => ({ model, price_source })),
    rates_basis: "current",
  };
}

/** Whether a row's calls are billed at the rate's long-context tier. */
function isLongContext(call: PricedTokens, rate: ModelPrice): boolean {
  const tier = rate.long_context;
  if (!tier) return false;
  if (call.prompt_tokens_exceed !== undefined) {
    return call.prompt_tokens_exceed >= tier.threshold_prompt_tokens;
  }
  return (call.calls ?? 1) === 1 && call.prompt_tokens > tier.threshold_prompt_tokens;
}

/**
 * The distinct long-context thresholds among a set of rates, ascending — the
 * cut points a cost query groups calls by, so every row lies wholly on one
 * side of every model's threshold.
 */
export function longContextThresholds(prices: readonly ModelPrice[]): number[] {
  const set = new Set<number>();
  for (const p of prices) if (p.long_context) set.add(p.long_context.threshold_prompt_tokens);
  return [...set].sort((a, b) => a - b);
}
