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
// Cache write is the price of the cache SubKit actually writes. For Anthropic
// that is the one-hour cache write (2x input), because every cache breakpoint
// the engine sets asks for the one-hour TTL (`PROMPT_CACHE_TTL`); a test pins
// the two together, so shortening the TTL without repricing fails. An
// operator's `cache_write_per_mtok` means the same thing: the rate for the TTL
// SubKit writes, not the vendor's five-minute rate.
//
// A vendor that bills long prompts higher lists that tier as `long_context`;
// cost queries split calls at its threshold, one call at a time.

import { type ModelPrice, type SourcedModelPrice, vendorModelId } from "./pricing.ts";

export const MODEL_PRICE_CATALOG_CURRENCY = "USD";

export interface CatalogModelPrice extends ModelPrice {
  /** Where the price was read. A rate nobody can trace is a rate nobody can correct. */
  source: string;
}

const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";

/** Anthropic's one-hour cache write, as a multiple of the input rate. */
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
  // Prompts over 272k tokens are billed at the long-context rates in full.
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
  // The first gpt-4o snapshot keeps its own, higher price and no cached-input
  // rate. Listed exactly, or its calls would fall back to the bare id's price.
  openai("gpt-4o-2024-05-13", 5, 15, 5),
  openai("gpt-4o-mini", 0.15, 0.6, 0.075),
  openai("gpt-4.1", 2, 8, 0.5),
  openai("gpt-4.1-mini", 0.4, 1.6, 0.1),
  // The alias of the snapshot `gpt-4-turbo-2024-04-09`, which the price list
  // names. It lists no cached-input rate — no discount, not a free read — so a
  // cached token is charged as input.
  openai("gpt-4-turbo", 10, 30, 10),
  // Prompts over 200k tokens are billed at the long-context rates in full.
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
    // aliases with the same vendor id (a dated snapshot) give way too, or a
    // call recorded under the alias would still be charged the catalog price.
    // Compared by vendor id, not by the platform-reducing bare id: an override
    // for a Bedrock id is the platform's price and must not unprice the
    // direct API's calls to the same model.
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
      // Flat: an operator's rate carries no long-context tier, so every call
      // of the model is charged it, however long its prompt.
      price_source: "override",
    });
  }
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}
