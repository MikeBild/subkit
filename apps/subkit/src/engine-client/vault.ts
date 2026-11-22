import type { components } from "@cli-core/engine-api/openapi.d.ts";
import type { EngineClient } from "../engine-client.ts";

export type VaultItem = components["schemas"]["VaultItem"];
export type VaultItemCreate = components["schemas"]["VaultItemCreate"];
export type VaultItemUpdate = components["schemas"]["VaultItemUpdate"];
export type VaultItemReveal = components["schemas"]["VaultItemReveal"];
export type VaultItemActivity = components["schemas"]["VaultItemActivity"];

export const vaultMethods = {
  async listVaultItems(
    this: EngineClient,
    query: { scope?: "workspace" | "person"; kind?: VaultItem["kind"] } = {},
  ): Promise<VaultItem[]> {
    const { data } = await this.api.GET("/v1/vault", { params: { query } });
    return (data as { items: VaultItem[] }).items;
  },
  async getVaultItem(this: EngineClient, id: string): Promise<VaultItem> {
    const { data } = await this.api.GET("/v1/vault/{id}", { params: { path: { id } } });
    return data as VaultItem;
  },
  async createVaultItem(this: EngineClient, body: VaultItemCreate): Promise<VaultItem> {
    const { data } = await this.api.POST("/v1/vault", { body });
    return data as VaultItem;
  },
  async updateVaultItem(this: EngineClient, id: string, body: VaultItemUpdate): Promise<VaultItem> {
    const { data } = await this.api.PATCH("/v1/vault/{id}", { params: { path: { id } }, body });
    return data as VaultItem;
  },
  async revealVaultItem(this: EngineClient, id: string): Promise<VaultItemReveal> {
    const { data } = await this.api.POST("/v1/vault/{id}/reveal", { params: { path: { id } } });
    return data as VaultItemReveal;
  },
  async vaultItemActivity(this: EngineClient, id: string): Promise<VaultItemActivity> {
    const { data } = await this.api.GET("/v1/vault/{id}/activity", { params: { path: { id } } });
    return data as VaultItemActivity;
  },
  async deleteVaultItem(this: EngineClient, id: string): Promise<void> {
    await this.api.DELETE("/v1/vault/{id}", { params: { path: { id } } });
  },
  async refreshVaultItem(this: EngineClient, id: string): Promise<void> {
    await this.api.POST("/v1/vault/{id}/refresh", { params: { path: { id } }, body: {} });
  },
};
