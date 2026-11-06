import type { components } from "@cli-core/engine-api/openapi";

export type ModelCatalog = components["schemas"]["SettingsModelCatalog"];
export type ModelCatalogEntry = components["schemas"]["SettingsModelCatalogEntry"];

const MODEL_CATALOG_ENDPOINT = "/v1/settings/catalog/models";

export function modelCatalogQueryKey(tenantId: string | null) {
  return ["admin", "settings", "catalog", tenantId] as const;
}

export function modelCatalogEndpoint(tenantId: string | null): string {
  return tenantId
    ? `${MODEL_CATALOG_ENDPOINT}?tenant=${encodeURIComponent(tenantId)}`
    : MODEL_CATALOG_ENDPOINT;
}

const CATALOG_FAMILY: Readonly<Record<string, ModelCatalogEntry["provider"]>> = {
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  vertex: "gemini",
};

export function modelsFor(
  catalog: ModelCatalog | undefined,
  provider: string,
): ModelCatalogEntry[] | null {
  const family = CATALOG_FAMILY[provider];
  if (!family) return null;
  return (catalog?.models ?? []).filter((entry) => entry.provider === family);
}

const PROVIDERS_DEFAULTING_TO_RECOMMENDED: ReadonlySet<string> = new Set(["openai", "gemini"]);

export function recommendedModel(
  catalog: ModelCatalog | undefined,
  provider: string,
): ModelCatalogEntry | null {
  if (!PROVIDERS_DEFAULTING_TO_RECOMMENDED.has(provider)) return null;
  return modelsFor(catalog, provider)?.find((entry) => entry.badges.recommended) ?? null;
}

export function catalogModelName(catalog: ModelCatalog | undefined, model: string): string | null {
  if (!model) return null;
  return catalog?.models.find((entry) => entry.model === model)?.display_name ?? null;
}
