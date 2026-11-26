import {
  type CacheWeights,
  DEFAULT_CACHE_WEIGHTS,
  findModelPrice,
  type ModelPrice,
  type SourcedModelPrice,
  vendorModelId,
} from "./pricing.ts";

export const MODEL_PRICE_CATALOG_CURRENCY = "USD";

export interface CatalogModelPrice extends ModelPrice {
  source: string;
}

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";

export const ANTHROPIC_ONE_HOUR_CACHE_WRITE_MULTIPLIER = 2;

const anthropic = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
): CatalogModelPrice => ({
  model,
  input_per_mtok: input,
  output_per_mtok: output,
  cache_read_per_mtok: cacheRead,
  cache_write_per_mtok: input * ANTHROPIC_ONE_HOUR_CACHE_WRITE_MULTIPLIER,
  source: ANTHROPIC_PRICING,
});

const openai = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
): CatalogModelPrice => ({
  model,
  input_per_mtok: input,
  output_per_mtok: output,
  cache_read_per_mtok: cacheRead,
  cache_write_per_mtok: input,
  source: OPENAI_PRICING,
});

const openaiAudio = (model: string, perMinute: number): CatalogModelPrice => ({
  model,
  input_per_mtok: 0,
  output_per_mtok: 0,
  cache_read_per_mtok: 0,
  cache_write_per_mtok: 0,
  audio_per_minute: perMinute,
  source: OPENAI_PRICING,
});

const gemini = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
): CatalogModelPrice => ({
  model,
  input_per_mtok: input,
  output_per_mtok: output,
  cache_read_per_mtok: cacheRead,
  cache_write_per_mtok: input,
  source: GEMINI_PRICING,
});

export const MODEL_PRICE_CATALOG: readonly CatalogModelPrice[] = Object.freeze([
  anthropic("claude-3-5-haiku", 0.8, 4, 0.08),
  anthropic("claude-haiku-4-5", 1, 5, 0.1),
  anthropic("claude-haiku-4-5-20251001", 1, 5, 0.1),
  anthropic("claude-sonnet-4-5", 3, 15, 0.3),
  anthropic("claude-sonnet-4-6", 3, 15, 0.3),
  anthropic("claude-sonnet-5", 2, 10, 0.2),
  anthropic("claude-opus-4-6", 5, 25, 0.5),
  anthropic("claude-opus-4-7", 5, 25, 0.5),
  anthropic("claude-opus-4-8", 5, 25, 0.5),
  anthropic("claude-opus-5-5", 4, 20, 0.2),
  anthropic("claude-fable-5", 10, 50, 1),
  anthropic("claude-fable-5-1", 10, 50, 0.25),
  {
    model: "gpt-5.6-sol",
    input_per_mtok: 4,
    output_per_mtok: 20,
    cache_read_per_mtok: 0.4,
    cache_write_per_mtok: 5,
    long_context: {
      threshold_prompt_tokens: 272_000,
      input_per_mtok: 8,
      output_per_mtok: 30,
      cache_read_per_mtok: 0.8,
      cache_write_per_mtok: 10,
    },
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  openai("gpt-4o", 2.5, 10, 1.25),
  openai("gpt-4o-2024-05-13", 5, 15, 5),
  openai("gpt-4o-mini", 0.15, 0.6, 0.075),
  openai("gpt-4.1", 2, 8, 0.5),
  openai("gpt-4.1-mini", 0.4, 1.6, 0.1),
  openai("gpt-4-turbo", 10, 30, 10),
  openaiAudio("gpt-4o-mini-transcribe", 0.003),
  openaiAudio("gpt-4o-transcribe", 0.006),
  openaiAudio("whisper-1", 0.006),
  {
    ...gemini("gemini-2.5-pro", 1.25, 10, 0.125),
    long_context: {
      threshold_prompt_tokens: 200_000,
      input_per_mtok: 2.5,
      output_per_mtok: 15,
      cache_read_per_mtok: 0.25,
      cache_write_per_mtok: 2.5,
    },
  },
  gemini("gemini-2.5-flash", 0.3, 2.5, 0.03),
]);

export function effectiveModelPrices(tokens: {
  currency?: string;
  prices?: readonly ModelPrice[];
}): SourcedModelPrice[] {
  const currency = (tokens.currency ?? MODEL_PRICE_CATALOG_CURRENCY).trim().toUpperCase();
  const byModel = new Map<string, SourcedModelPrice>();
  if (currency === MODEL_PRICE_CATALOG_CURRENCY) {
    for (const { source: _source, ...price } of MODEL_PRICE_CATALOG) {
      byModel.set(price.model, { ...price, price_source: "catalog" });
    }
  }
  for (const price of tokens.prices ?? []) {
    const vendor = vendorModelId(price.model);
    for (const [model, existing] of byModel) {
      if (existing.price_source === "catalog" && vendorModelId(model) === vendor) {
        byModel.delete(model);
      }
    }
    byModel.set(price.model, {
      model: price.model,
      input_per_mtok: price.input_per_mtok,
      output_per_mtok: price.output_per_mtok,
      cache_read_per_mtok: price.cache_read_per_mtok ?? 0,
      cache_write_per_mtok: price.cache_write_per_mtok ?? 0,
      ...(price.audio_per_minute === undefined ? {} : { audio_per_minute: price.audio_per_minute }),
      price_source: "override",
    });
  }
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

export function cacheWeightsFor(model: string): CacheWeights {
  const price = findModelPrice(model, effectiveModelPrices({}))?.rate;
  if (
    !price ||
    price.input_per_mtok <= 0 ||
    price.cache_read_per_mtok <= 0 ||
    price.cache_write_per_mtok <= 0
  )
    return DEFAULT_CACHE_WEIGHTS;
  const ratio = (rate: number) => Math.round((rate / price.input_per_mtok) * 10_000) / 10_000;
  return { read: ratio(price.cache_read_per_mtok), create: ratio(price.cache_write_per_mtok) };
}
