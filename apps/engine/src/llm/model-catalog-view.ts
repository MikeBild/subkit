import { modelDisplayName } from "./model-names.ts";
import {
  effectiveModelPrices,
  MODEL_PRICE_CATALOG,
  MODEL_PRICE_CATALOG_CURRENCY,
} from "./model-price-catalog.ts";
import { type ModelPrice, vendorModelId } from "./pricing.ts";

export const CATALOG_MODEL_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type CatalogModelProvider = (typeof CATALOG_MODEL_PROVIDERS)[number];

export const RECOMMENDED_MODELS: Readonly<Record<CatalogModelProvider, string>> = Object.freeze({
  anthropic: "claude-sonnet-5",
  openai: "gpt-4.1-mini",
  gemini: "gemini-2.5-flash",
});

export type DefaultModelRole = "primary" | "fallback" | "light";

export const DEFAULT_MODELS: Readonly<
  Record<CatalogModelProvider, Readonly<Record<DefaultModelRole, string>>>
> = Object.freeze({
  anthropic: Object.freeze({
    primary: "claude-sonnet-4-6",
    fallback: "claude-opus-4-7",
    light: "claude-haiku-4-5",
  }),
  openai: Object.freeze({
    primary: RECOMMENDED_MODELS.openai,
    fallback: RECOMMENDED_MODELS.openai,
    light: RECOMMENDED_MODELS.openai,
  }),
  gemini: Object.freeze({
    primary: RECOMMENDED_MODELS.gemini,
    fallback: RECOMMENDED_MODELS.gemini,
    light: RECOMMENDED_MODELS.gemini,
  }),
});

export function isCatalogModelProvider(provider: string): provider is CatalogModelProvider {
  return (CATALOG_MODEL_PROVIDERS as readonly string[]).includes(provider);
}

export function defaultModelFor(
  provider: string,
  role: DefaultModelRole = "primary",
): string | undefined {
  return isCatalogModelProvider(provider) ? DEFAULT_MODELS[provider][role] : undefined;
}

export function catalogDefaultModelIds(): string[] {
  return [...new Set(Object.values(DEFAULT_MODELS).flatMap((roles) => Object.values(roles)))];
}

export function modelFamilyMismatch(provider: string, model: string): boolean {
  if (!isCatalogModelProvider(provider) || !model) return false;
  const family = catalogModelProvider(model);
  return family !== null && family !== provider;
}

interface LlmModelSettings {
  provider: string;
  model?: string;
  fallback_provider?: string | null;
  fallback_model?: string;
  summarize_provider?: string | null;
  summarize_model?: string;
  suggestion_model?: string;
  providers?: object;
}

const MODEL_SETTING_LEAVES = [
  "model",
  "fallback_model",
  "summarize_model",
  "suggestion_model",
] as const;
type ModelSettingLeaf = (typeof MODEL_SETTING_LEAVES)[number];

function targetProviderOf(llm: LlmModelSettings, leaf: ModelSettingLeaf): string {
  if (leaf === "fallback_model") return llm.fallback_provider || llm.provider;
  if (leaf === "summarize_model") return llm.summarize_provider || llm.provider;
  return llm.provider;
}

export function isModelSettingLeaf(leaf: string): leaf is ModelSettingLeaf {
  return (MODEL_SETTING_LEAVES as readonly string[]).includes(leaf);
}

export function modelProviderMismatch(
  llm: LlmModelSettings,
  leaf: ModelSettingLeaf,
  value: unknown = llm[leaf],
): string | null {
  const model = typeof value === "string" ? value.trim() : "";
  if (!model) return null;
  const provider = targetProviderOf(llm, leaf);
  if (!modelFamilyMismatch(provider, model)) return null;
  const endpoint = (
    llm.providers as Record<string, { base_url?: unknown } | undefined> | undefined
  )?.[provider];
  if (typeof endpoint?.base_url === "string" && endpoint.base_url) return null;
  const family = catalogModelProvider(model);
  return `llm.${leaf} '${model}' is a ${family} model, but it would be sent to the ${provider} provider. Choose a ${provider} model such as '${defaultModelFor(provider)}', leave it empty for the provider default, or change the provider first.`;
}

export const MODEL_BADGE_OUTPUT_PRICE = Object.freeze({ economicalAtMost: 5, capableAtLeast: 15 });

interface CatalogModelBadges {
  recommended: boolean;
  economical: boolean;
  capable: boolean;
}

export interface CatalogModelEntry {
  provider: CatalogModelProvider | null;
  model: string;
  display_name: string;
  input_per_mtok: number | null;
  output_per_mtok: number | null;
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
  ["o", "openai"],
  ["gemini-", "gemini"],
];

export function catalogModelProvider(model: string): CatalogModelProvider | null {
  const id = vendorModelId(model.includes(":") ? model.slice(model.indexOf(":") + 1) : model);
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix) && (prefix !== "o" || /^o\d+(?:-|$)/.test(id))) return provider;
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
    const provider = catalogModelProvider(price.model);
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
  for (const price of MODEL_PRICE_CATALOG) {
    const name = modelDisplayName(price.model);
    const vendor = vendorModelId(price.model);
    if (name === null || byVendor.has(vendor)) continue;
    const provider = catalogModelProvider(price.model);
    byVendor.set(vendor, {
      provider,
      model: price.model,
      display_name: name,
      input_per_mtok: null,
      output_per_mtok: null,
      price_source: "catalog",
      badges: badgesFor(provider, price.model, price.output_per_mtok),
    });
  }
  const models = [...byVendor.values()].sort((a, b) =>
    a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
  );
  return { currency, models };
}
