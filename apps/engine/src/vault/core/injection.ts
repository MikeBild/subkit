import {
  formatVaultPlaceholder,
  parseVaultHandle,
  type VaultHandle,
} from "@shared/vault-handle.ts";

export type VaultInjectionFailure =
  | "parse_error"
  | "secret_withheld"
  | "key_not_found"
  | "decrypt_failed";

export type VaultInjection =
  | { readonly ok: true; readonly value: string; readonly secrets: readonly string[] }
  | { readonly ok: false; readonly code: VaultInjectionFailure; readonly message: string };

export type PreparedVaultValue =
  | { readonly ok: true; readonly value: string; readonly secrets: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "key_not_found" | "decrypt_failed";
      readonly message: string;
    };

export type PreparedVaultValues = ReadonlyMap<string, PreparedVaultValue>;

export function vaultValueKey(handle: VaultHandle): string {
  return formatVaultPlaceholder(handle);
}

export function injectVaultValue(
  token: string,
  path: readonly string[],
  values: PreparedVaultValues | null,
): VaultInjection {
  const handle = parseVaultHandle(path);
  if (!handle) return { ok: false, code: "parse_error", message: `malformed ${token}` };
  if (!values)
    return {
      ok: false,
      code: "secret_withheld",
      message: `${token} is resolved only in the headers, query or body of a connector step of an approved workflow run; approve the workflow and send it through its connector`,
    };
  const prepared = values.get(vaultValueKey(handle));
  if (!prepared)
    return {
      ok: false,
      code: "secret_withheld",
      message: `${token} was not prepared for this step; only the headers, query and body of a connector step carry vault values`,
    };
  return prepared;
}
