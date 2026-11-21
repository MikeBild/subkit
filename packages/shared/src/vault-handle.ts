export const VAULT_ITEM_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const VAULT_PERSON_SEGMENT = "me";
export const VAULT_PLACEHOLDER_ROOT = "secret";
export const VAULT_FIELDS = ["token", "username", "password"] as const;

export type VaultScope = "workspace" | "person";
export type VaultField = (typeof VAULT_FIELDS)[number];

export interface VaultHandle {
  readonly scope: VaultScope;
  readonly name: string;
  readonly field: VaultField | null;
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const SECRET_REF = /^secret:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})\/([1-9][0-9]*)$/;

export function isVaultItemName(value: string): boolean {
  return VAULT_ITEM_NAME.test(value) && value !== VAULT_PERSON_SEGMENT;
}

function isVaultField(value: string): value is VaultField {
  return (VAULT_FIELDS as readonly string[]).includes(value);
}

export function parseVaultHandle(path: readonly string[]): VaultHandle | null {
  const person = path[0] === VAULT_PERSON_SEGMENT;
  const rest = person ? path.slice(1) : path;
  const [name, field, extra] = rest;
  if (name === undefined || extra !== undefined || !isVaultItemName(name)) return null;
  if (field !== undefined && !isVaultField(field)) return null;
  return { scope: person ? "person" : "workspace", name, field: field ?? null };
}

export function vaultHandleKey(handle: VaultHandle): string {
  const segments = [handle.scope === "person" ? VAULT_PERSON_SEGMENT : null, handle.name];
  return segments.filter((segment) => segment !== null).join(".");
}

export function formatVaultPlaceholder(handle: VaultHandle): string {
  const field = handle.field ? `.${handle.field}` : "";
  return `\${${VAULT_PLACEHOLDER_ROOT}.${vaultHandleKey(handle)}${field}}`;
}

export function vaultItemNameFrom(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return isVaultItemName(name) ? name : `item-${name}`;
}

export function parseSecretReference(value: string): { name: string; version: number } | null {
  const match = SECRET_REF.exec(value);
  if (!match) return null;
  return { name: match[1] as string, version: Number(match[2]) };
}

export function secretReference(name: string, version: number): string {
  return `secret://${name}/${version}`;
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function containsSecretReference(value: unknown): boolean {
  if (typeof value === "string") return parseSecretReference(value) !== null;
  return Object.values(Object(value) as Record<string, unknown>).some(containsSecretReference);
}
