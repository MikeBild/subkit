import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type TenantBranding = components["schemas"]["TenantBrandingResponse"];
export type TenantBrandingUpdate = components["schemas"]["TenantBrandingUpdate"];

export const brandingMethods = {
  async getTenantBranding(this: EngineClient): Promise<TenantBranding> {
    const { data } = await this.api.GET("/v1/tenant/branding");
    return data as TenantBranding;
  },
  async updateTenantBranding(
    this: EngineClient,
    body: TenantBrandingUpdate,
  ): Promise<TenantBranding> {
    const { data } = await this.api.PUT("/v1/tenant/branding", { body });
    return data as TenantBranding;
  },
  async resetTenantBranding(this: EngineClient, revision: number): Promise<TenantBranding> {
    const { data } = await this.api.DELETE("/v1/tenant/branding", { body: { revision } });
    return data as TenantBranding;
  },
  async getTenantBrandingLogo(
    this: EngineClient,
    opts: { theme: "light" | "dark"; revision?: number },
  ): Promise<Uint8Array> {
    const revision = opts.revision ?? (await this.getTenantBranding()).revision;
    const params = new URLSearchParams({ theme: opts.theme });
    if (this.tenant) params.set("tenant_context", this.tenant);
    params.set("revision", String(revision));
    return this.requestBytes(`/v1/tenant/branding/logo?${params}`);
  },
};
