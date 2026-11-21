export {
  connectorItemName,
  normalizeItemName,
  templateClientItemName,
  vaultValueOf,
  withNameSuffix,
} from "./core/vault-item.ts";
export type { VaultActivityEntry, VaultItemView } from "./service.ts";
export {
  createVaultItem,
  deleteVaultItem,
  getVaultItem,
  listVaultItems,
  resolveVaultHandle,
  revealVaultItem,
  updateVaultItem,
  VaultError,
  vaultItemActivity,
  vaultViewer,
} from "./service.ts";
