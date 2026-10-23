import type { components } from "@/api/schema";

export type ModelCatalog = components["schemas"]["SettingsModelCatalog"];
export type ModelCatalogEntry = components["schemas"]["SettingsModelCatalogEntry"];

export const MODEL_CATALOG_ENDPOINT = "/v1/settings/catalog/models";

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

export function catalogModelName(catalog: ModelCatalog | undefined, model: string): string | null {
  if (!model) return null;
  return catalog?.models.find((entry) => entry.model === model)?.display_name ?? null;
}
