export type {
  PreparedVaultValue,
  PreparedVaultValues,
  VaultInjection,
  VaultInjectionFailure,
} from "./core/injection.ts";
export { injectVaultValue, vaultValueKey } from "./core/injection.ts";
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
  prepareVaultValues,
  resolveVaultHandle,
  revealVaultItem,
  updateVaultItem,
  VaultError,
  vaultItemActivity,
  vaultViewer,
} from "./service.ts";
