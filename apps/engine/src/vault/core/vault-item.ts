import {
  isVaultItemName,
  type VaultField,
  type VaultHandle,
  type VaultScope,
  vaultItemNameFrom,
} from "@shared/vault-handle.ts";
import {
  isVaultEntryKind,
  type VaultEntryKind,
  type VaultEntryValue,
  type VaultKind,
} from "@shared/vault-kinds.ts";
import { secretsOf } from "./kinds.ts";

export type VaultItemKind = VaultKind;
export type { VaultEntryKind };
export type VaultEnvironment = "dev" | "prod";
export type VaultAction = "read" | "write" | "rotate" | "delete" | "reveal" | "use";

export const VAULT_PERMISSION: Readonly<Record<VaultAction, string>> = {
  read: "vault:read",
  write: "vault:write",
  rotate: "vault:rotate",
  delete: "vault:delete",
  reveal: "vault:reveal",
  use: "vault:use",
};

export interface VaultViewer {
  readonly user_id: string | null;
  readonly permissions: ReadonlySet<string>;
}

export interface VaultItemFacts {
  readonly kind: VaultItemKind;
  readonly owner_user_id: string | null;
}

export type VaultValue = VaultEntryValue;

const CONNECTOR_NAME_BASE = 54;

export function connectorItemName(slug: string, environment: string, mode: string): string {
  return vaultItemNameFrom(`${slug}-${environment}-${mode}`)
    .slice(0, CONNECTOR_NAME_BASE)
    .replace(/[-_]+$/, "");
}

export function templateClientItemName(templateSlug: string): string {
  return vaultItemNameFrom(`template-${templateSlug}`);
}

export function withNameSuffix(name: string, suffix: string): string {
  return `${name.slice(0, 63 - suffix.length - 1)}-${suffix}`;
}

export function vaultScopeOf(item: Pick<VaultItemFacts, "owner_user_id">): VaultScope {
  return item.owner_user_id === null ? "workspace" : "person";
}

export function isEditableKind(kind: VaultItemKind): kind is VaultEntryKind {
  return isVaultEntryKind(kind);
}

export function vaultAccess(
  viewer: VaultViewer,
  item: VaultItemFacts,
  action: VaultAction,
): "allow" | "hidden" | "denied" {
  if (item.owner_user_id !== null) {
    return viewer.user_id === item.owner_user_id ? "allow" : "hidden";
  }
  if (!viewer.permissions.has(VAULT_PERMISSION.read)) return "hidden";
  if ((action === "write" || action === "rotate") && !isEditableKind(item.kind)) return "denied";
  return viewer.permissions.has(VAULT_PERMISSION[action]) ? "allow" : "denied";
}

export function vaultValueOf(
  kind: "secret" | "login",
  input: {
    token?: string | undefined;
    username?: string | undefined;
    password?: string | undefined;
  },
): VaultValue | string {
  if (kind === "secret") {
    if (!input.token) return "a secret needs a token";
    return { kind, token: input.token };
  }
  if (!input.username || !input.password) return "a login needs a username and a password";
  return { kind, username: input.username, password: input.password };
}

export interface VaultLoginPatch {
  readonly kind: "login_patch";
  readonly username?: string;
  readonly password?: string;
  readonly totp_seed?: string | null;
}

export function vaultRotationOf(
  kind: "secret" | "login",
  input: {
    token?: string | undefined;
    username?: string | undefined;
    password?: string | undefined;
  },
): VaultValue | VaultLoginPatch | string {
  const partialLogin =
    kind === "login" && (input.username === undefined) !== (input.password === undefined);
  if (!partialLogin) return vaultValueOf(kind, input);
  if (input.username !== undefined) {
    return input.username
      ? { kind: "login_patch", username: input.username }
      : "a login needs a username";
  }
  return input.password
    ? { kind: "login_patch", password: input.password }
    : "a login needs a password";
}

export function mergedLoginValue(
  stored: Readonly<Record<string, string>>,
  patch: VaultLoginPatch,
): VaultValue | string {
  const merged = vaultValueOf("login", {
    username: patch.username ?? stored.username,
    password: patch.password ?? stored.password,
  });
  const totp_seed = patch.totp_seed === undefined ? stored.totp_seed : patch.totp_seed;
  if (typeof merged === "string" || merged.kind !== "login" || !totp_seed) return merged;
  return { ...merged, totp_seed };
}

export function vaultFieldValue(value: VaultValue, field: VaultField | null): string | null {
  if (value.kind === "secret") return field === null || field === "token" ? value.token : null;
  if (value.kind !== "login") return null;
  if (field === "username") return value.username;
  if (field === "password") return value.password;
  return null;
}

export function vaultSecretsOf(value: VaultValue): string[] {
  return secretsOf(value);
}

export function handleMatches(
  handle: VaultHandle,
  item: { readonly name: string; readonly owner_user_id: string | null },
  user_id: string | null,
): boolean {
  if (handle.name !== item.name) return false;
  if (handle.scope === "workspace") return item.owner_user_id === null;
  return user_id !== null && item.owner_user_id === user_id;
}

export function normalizeItemName(raw: string): string | null {
  const name = raw.trim();
  return isVaultItemName(name) ? name : null;
}
