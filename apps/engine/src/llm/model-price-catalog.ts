// The built-in model price catalog.
//
// SubKit ships list prices for the models it picks on its own and the models
// operators most commonly configure, so a fresh installation answers "what did
// this cost" without anyone typing a rate first. The catalog is code, compiled
// into the binary, and it is never copied into the stored configuration: a
// release that corrects or adds a price corrects every answer the moment it is
// running, for every model an operator has not priced themselves.
//
// `tokens.prices` is the operator's word and wins per model. A model the
// operator priced uses that rate; every other model uses the catalog.
//
// The catalog is quoted in US dollars, because that is what the vendors
// publish. A tenant that keeps its books in another currency gets no catalog
// prices at all — only its own — since adding dollars to euros produces a
// number that is neither.
//
// Cache write is the five-minute cache write price.

import { bareModelId, type ModelPrice, type SourcedModelPrice } from "./pricing.ts";

export const MODEL_PRICE_CATALOG_CURRENCY = "USD";

export interface CatalogModelPrice extends ModelPrice {
  /** Where the price was read. A rate nobody can trace is a rate nobody can correct. */
  source: string;
}

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";

const anthropic = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): CatalogModelPrice => ({
  model,
  input_per_mtok: input,
  output_per_mtok: output,
  cache_read_per_mtok: cacheRead,
  cache_write_per_mtok: cacheWrite,
  source: ANTHROPIC_PRICING,
});

/**
 * OpenAI and Google charge no surcharge for writing the cache: a prompt that
 * lands in the cache is billed as ordinary input, so the cache-write rate is
 * the input rate.
 */
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
  // Retired on the Claude API, still listed with its price.
  anthropic("claude-3-5-haiku", 0.8, 4, 0.08, 1),
  anthropic("claude-haiku-4-5", 1, 5, 0.1, 1.25),
  anthropic("claude-haiku-4-5-20251001", 1, 5, 0.1, 1.25),
  anthropic("claude-sonnet-4-5", 3, 15, 0.3, 3.75),
  anthropic("claude-sonnet-4-6", 3, 15, 0.3, 3.75),
  anthropic("claude-sonnet-5", 2, 10, 0.2, 2.5),
  anthropic("claude-opus-4-6", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-7", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-4-8", 5, 25, 0.5, 6.25),
  anthropic("claude-opus-5-5", 4, 20, 0.2, 5),
  anthropic("claude-fable-5", 10, 50, 1, 12.5),
  anthropic("claude-fable-5-1", 10, 50, 0.25, 12.5),
  {
    model: "gpt-5.6-sol",
    input_per_mtok: 4,
    output_per_mtok: 20,
    cache_read_per_mtok: 0.4,
    cache_write_per_mtok: 5,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
  openai("gpt-4o", 2.5, 10, 1.25),
  openai("gpt-4o-mini", 0.15, 0.6, 0.075),
  openai("gpt-4.1", 2, 8, 0.5),
  openai("gpt-4.1-mini", 0.4, 1.6, 0.1),
  // The alias of the snapshot `gpt-4-turbo-2024-04-09`, which the price list
  // names. It lists no cached-input rate — no discount, not a free read — so a
  // cached token is charged as input.
  openai("gpt-4-turbo", 10, 30, 10),
  // The rate for prompts up to 200k tokens; longer prompts are billed higher
  // (input 2.50, output 15, cache read 0.25), so a window with long prompts is
  // priced below its bill — the same base-rate simplification the catalog
  // makes for every tiered model.
  gemini("gemini-2.5-pro", 1.25, 10, 0.125),
  // Text, image and video input; audio input is billed higher.
  gemini("gemini-2.5-flash", 0.3, 2.5, 0.03),
]);

/**
 * The rates in force for a tenant: the catalog, with the operator's entries
 * replacing it model by model.
 *
 * Computed on every read and never written back, so the stored
 * `tokens.prices` holds exactly what the operator entered and nothing a
 * release put there.
 */
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
    // An override speaks for the model, not for one spelling of it: catalog
    // aliases with the same bare id (a dated snapshot) give way too, or a call
    // recorded under the alias would still be charged the catalog price.
    const bare = bareModelId(price.model);
    for (const [model, existing] of byModel) {
      if (existing.price_source === "catalog" && bareModelId(model) === bare) byModel.delete(model);
    }
    byModel.set(price.model, {
      model: price.model,
      input_per_mtok: price.input_per_mtok,
      output_per_mtok: price.output_per_mtok,
      cache_read_per_mtok: price.cache_read_per_mtok ?? 0,
      cache_write_per_mtok: price.cache_write_per_mtok ?? 0,
      price_source: "override",
    });
  }
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}
