import type { components } from "@cli-core/engine-api/openapi";
import { apiCall } from "./call";

type VaultItem = components["schemas"]["VaultItem"];
type VaultItemCreate = components["schemas"]["VaultItemCreate"];
type VaultItemUpdate = components["schemas"]["VaultItemUpdate"];
type VaultItemReveal = components["schemas"]["VaultItemReveal"];
type VaultActivity = components["schemas"]["VaultItemActivity"];

export const VAULT_KEY = ["vault"] as const;

export function vaultActivityKey(id: string) {
  return [...VAULT_KEY, id, "activity"] as const;
}

export async function listVaultItems(): Promise<VaultItem[]> {
  return (await apiCall("get", "/v1/vault", {})).items;
}

export function createVaultItem(body: VaultItemCreate): Promise<VaultItem> {
  return apiCall("post", "/v1/vault", { body });
}

export function updateVaultItem(id: string, body: VaultItemUpdate): Promise<VaultItem> {
  return apiCall("patch", "/v1/vault/{id}", { path: { id }, body });
}

export async function deleteVaultItem(id: string): Promise<void> {
  await apiCall("delete", "/v1/vault/{id}", { path: { id } });
}

export function revealVaultItem(id: string): Promise<VaultItemReveal> {
  return apiCall("post", "/v1/vault/{id}/reveal", { path: { id } });
}

export async function listVaultActivity(id: string): Promise<VaultActivity["items"]> {
  return (await apiCall("get", "/v1/vault/{id}/activity", { path: { id } })).items;
}
