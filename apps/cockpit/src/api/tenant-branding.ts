import type { components } from "@cli-core/engine-api/openapi";
import { apiRequest } from "./client";

export type TenantBranding = components["schemas"]["TenantBrandingResponse"];
export type TenantBrandingUpdate = components["schemas"]["TenantBrandingUpdate"];
export type BrandingPalette = NonNullable<TenantBranding["palette"]>;

export function readTenantBranding(): Promise<TenantBranding> {
  return apiRequest("/v1/tenant/branding");
}

export function saveTenantBranding(value: TenantBrandingUpdate): Promise<TenantBranding> {
  return apiRequest("/v1/tenant/branding", { method: "PUT", body: JSON.stringify(value) });
}

export function resetTenantBranding(revision: number): Promise<TenantBranding> {
  return apiRequest("/v1/tenant/branding", {
    method: "DELETE",
    body: JSON.stringify({ revision }),
  });
}
