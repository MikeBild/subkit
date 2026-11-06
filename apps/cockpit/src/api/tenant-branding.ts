import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

export type TenantBranding = components["schemas"]["TenantBrandingResponse"];
export type TenantBrandingUpdate = components["schemas"]["TenantBrandingUpdate"];
export type BrandingPalette = NonNullable<TenantBranding["palette"]>;

export function readTenantBranding(): Promise<TenantBranding> {
  return apiCall("get", "/v1/tenant/branding", {});
}

export function saveTenantBranding(value: TenantBrandingUpdate): Promise<TenantBranding> {
  return apiCall("put", "/v1/tenant/branding", { body: value });
}

export function resetTenantBranding(revision: number): Promise<TenantBranding> {
  return apiCall("delete", "/v1/tenant/branding", { body: { revision } });
}
