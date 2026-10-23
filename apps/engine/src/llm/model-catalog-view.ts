import { modelDisplayName } from "./model-names.ts";
import { effectiveModelPrices, MODEL_PRICE_CATALOG_CURRENCY } from "./model-price-catalog.ts";
import { type ModelPrice, vendorModelId } from "./pricing.ts";

export const CATALOG_MODEL_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type CatalogModelProvider = (typeof CATALOG_MODEL_PROVIDERS)[number];

export const RECOMMENDED_MODELS: Readonly<Record<CatalogModelProvider, string>> = Object.freeze({
  anthropic: "claude-sonnet-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
});

export const MODEL_BADGE_OUTPUT_PRICE = Object.freeze({ economicalAtMost: 5, capableAtLeast: 15 });

export interface CatalogModelBadges {
  recommended: boolean;
  economical: boolean;
  capable: boolean;
}

export interface CatalogModelEntry {
  provider: CatalogModelProvider | null;
  model: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  price_source: "catalog" | "override";
  badges: CatalogModelBadges;
}

export interface ModelCatalogView {
  currency: string;
  models: CatalogModelEntry[];
}

const PROVIDER_PREFIXES: ReadonlyArray<readonly [string, CatalogModelProvider]> = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["gemini-", "gemini"],
];

function providerOf(model: string): CatalogModelProvider | null {
  const id = vendorModelId(model);
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix)) return provider;
  }
  return null;
}

function badgesFor(
  provider: CatalogModelProvider | null,
  model: string,
  outputPerMtok: number,
): CatalogModelBadges {
  return {
    recommended: provider !== null && RECOMMENDED_MODELS[provider] === model,
    economical: outputPerMtok <= MODEL_BADGE_OUTPUT_PRICE.economicalAtMost,
    capable: outputPerMtok >= MODEL_BADGE_OUTPUT_PRICE.capableAtLeast,
  };
}

export function modelCatalogView(tokens: {
  currency?: string;
  prices?: readonly ModelPrice[];
}): ModelCatalogView {
  const currency = (tokens.currency ?? MODEL_PRICE_CATALOG_CURRENCY).trim().toUpperCase();
  const byVendor = new Map<string, CatalogModelEntry>();
  for (const price of effectiveModelPrices(tokens)) {
    const override = price.price_source === "override";
    const name = modelDisplayName(price.model);
    if (!override && name === null) continue;
    const vendor = vendorModelId(price.model);
    const existing = byVendor.get(vendor);
    if (existing && (existing.price_source === "override" || existing.model === vendor)) {
      if (!override || existing.price_source === "override") continue;
    }
    const provider = providerOf(price.model);
    byVendor.set(vendor, {
      provider,
      model: price.model,
      display_name: name ?? price.model,
      input_per_mtok: price.input_per_mtok,
      output_per_mtok: price.output_per_mtok,
      price_source: override ? "override" : "catalog",
      badges: badgesFor(provider, price.model, price.output_per_mtok),
    });
  }
  const models = [...byVendor.values()].sort((a, b) =>
    a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
  );
  return { currency, models };
}
