import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type TenantBranding = components["schemas"]["TenantBrandingResponse"];
export type TenantBrandingUpdate = components["schemas"]["TenantBrandingUpdate"];

export const brandingMethods = {
  getTenantBranding(this: EngineClient): Promise<TenantBranding> {
    return this.request("GET", "/v1/tenant/branding");
  },
  updateTenantBranding(this: EngineClient, body: TenantBrandingUpdate): Promise<TenantBranding> {
    return this.request("PUT", "/v1/tenant/branding", body);
  },
  resetTenantBranding(this: EngineClient, revision: number): Promise<TenantBranding> {
    return this.request("DELETE", "/v1/tenant/branding", { revision });
  },
  getTenantBrandingLogo(
    this: EngineClient,
    opts: { theme: "light" | "dark"; revision?: number },
  ): Promise<Uint8Array> {
    const params = new URLSearchParams({ theme: opts.theme });
    if (this.tenant) params.set("tenant_context", this.tenant);
    if (opts.revision !== undefined) params.set("revision", String(opts.revision));
    return this.requestBytes(`/v1/tenant/branding/logo?${params}`);
  },
};
