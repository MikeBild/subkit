export interface TokenUsageBreakdown {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export const CACHE_READ_WEIGHT = 0.1;

export const CACHE_CREATE_WEIGHT = 2;

export function weightedTotalTokens(u: TokenUsageBreakdown): number {
  const uncached = Math.max(0, u.prompt_tokens - u.cache_read_tokens - u.cache_creation_tokens);
  return (
    u.completion_tokens +
    uncached +
    Math.round(u.cache_read_tokens * CACHE_READ_WEIGHT) +
    Math.round(u.cache_creation_tokens * CACHE_CREATE_WEIGHT)
  );
}

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

export function vendorModelId(modelId: string): string {
  return stripDateStamp(stripProvider(modelId));
}

function stripProvider(id: string): string {
  return id.includes("/") ? (id.split("/").pop() ?? id) : id;
}

function stripDateStamp(id: string): string {
  return id.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
}

const BEDROCK_ID = /^(?:(?:us|eu|apac|global)\.)?anthropic\.(.+?)(?:-v\d+(?::\d+)?)?$/;
const VERTEX_ID = /^(claude-.+)@\d{8}$/;

export function bareModelId(modelId: string): string {
  const id = stripProvider(modelId);
  const platform = BEDROCK_ID.exec(id)?.[1] ?? VERTEX_ID.exec(id)?.[1];
  return stripDateStamp(platform ?? id);
}

export interface LongContextPrice {
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
  long_context?: LongContextPrice;
}

export const PRICE_SOURCES = ["catalog", "catalog_normalized", "override"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export interface SourcedModelPrice extends ModelPrice {
  price_source: PriceSource;
}

export interface PricedTokens extends TokenUsageBreakdown {
  model: string;
  calls?: number;
  prompt_tokens_exceed?: number;
}

export interface CostResult {
  amount: number;
  currency: string;
  unpriced_models: string[];
  unpriced_calls: number;
  cache_savings: number;
  price_sources: Array<{ model: string; price_source: PriceSource }>;
  rates_basis: "current";
}

export function findModelPrice(
  model: string,
  prices: readonly SourcedModelPrice[],
): { rate: SourcedModelPrice; source: PriceSource } | undefined {
  const byModel = new Map(prices.map((p) => [p.model, p]));
  return lookupModelPrice(model, byModel);
}

function lookupModelPrice(
  model: string,
  byModel: ReadonlyMap<string, SourcedModelPrice>,
): { rate: SourcedModelPrice; source: PriceSource } | undefined {
  const exact = byModel.get(model) ?? byModel.get(vendorModelId(model));
  if (exact) return { rate: exact, source: exact.price_source };
  const normalized = byModel.get(bareModelId(model));
  if (!normalized) return undefined;
  return {
    rate: normalized,
    source: normalized.price_source === "catalog" ? "catalog_normalized" : normalized.price_source,
  };
}

export function priceCalls(
  calls: readonly PricedTokens[],
  prices: readonly SourcedModelPrice[],
  currency: string,
): CostResult {
  const byModel = new Map(prices.map((p) => [p.model, p]));
  const unpriced = new Map<string, number>();
  const sources = new Map<string, PriceSource>();
  let amount = 0;
  let savings = 0;

  for (const call of calls) {
    const found = lookupModelPrice(call.model, byModel);
    if (!found) {
      unpriced.set(call.model, (unpriced.get(call.model) ?? 0) + (call.calls ?? 1));
      continue;
    }
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
    savings +=
      (call.cache_read_tokens / 1_000_000) *
      Math.max(0, rate.input_per_mtok - rate.cache_read_per_mtok);
  }

  return {
    amount: Math.round(amount * 1e6) / 1e6,
    currency,
    unpriced_models: [...unpriced.keys()].sort(),
    unpriced_calls: [...unpriced.values()].reduce((sum, n) => sum + n, 0),
    cache_savings: Math.round(savings * 1e6) / 1e6,
    price_sources: [...sources.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([model, price_source]) => ({ model, price_source })),
    rates_basis: "current",
  };
}

function isLongContext(call: PricedTokens, rate: ModelPrice): boolean {
  const tier = rate.long_context;
  if (!tier) return false;
  if (call.prompt_tokens_exceed !== undefined) {
    return call.prompt_tokens_exceed >= tier.threshold_prompt_tokens;
  }
  return (call.calls ?? 1) === 1 && call.prompt_tokens > tier.threshold_prompt_tokens;
}

export function longContextThresholds(prices: readonly ModelPrice[]): number[] {
  const set = new Set<number>();
  for (const p of prices) if (p.long_context) set.add(p.long_context.threshold_prompt_tokens);
  return [...set].sort((a, b) => a - b);
}
