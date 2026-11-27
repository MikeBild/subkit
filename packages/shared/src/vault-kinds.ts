export const VAULT_KINDS = [
  "connector",
  "secret",
  "login",
  "template_client",
  "card",
  "bank_account",
  "identity",
  "address",
  "note",
] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

export const VAULT_ENTRY_KINDS = [
  "secret",
  "login",
  "card",
  "bank_account",
  "identity",
  "address",
  "note",
] as const;
export type VaultEntryKind = (typeof VAULT_ENTRY_KINDS)[number];

export const STRUCTURED_KINDS = ["card", "bank_account", "identity", "address", "note"] as const;
export type StructuredKind = (typeof STRUCTURED_KINDS)[number];

export const PERSONAL_ONLY_KINDS = ["card", "bank_account", "identity"] as const;
export type PersonalOnlyKind = (typeof PERSONAL_ONLY_KINDS)[number];

export const FRESH_AUTH_KINDS = ["card", "bank_account"] as const;

export const CONNECTOR_STEP_KINDS = ["secret", "login"] as const;

export interface SecretValue {
  readonly token: string;
}

export interface LoginValue {
  readonly username: string;
  readonly password: string;
  readonly totp_seed?: string;
}

export interface CardValue {
  readonly number: string;
  readonly exp_month: number;
  readonly exp_year: number;
  readonly holder: string;
}

export interface BankAccountValue {
  readonly iban: string;
  readonly bic?: string;
  readonly holder: string;
}

export interface IdentityValue {
  readonly full_name: string;
  readonly birth_date?: string;
  readonly document_type?: string;
  readonly document_number?: string;
  readonly nationality?: string;
}

export interface AddressValue {
  readonly name?: string;
  readonly line1: string;
  readonly line2?: string;
  readonly postal_code: string;
  readonly city: string;
  readonly region?: string;
  readonly country: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface NoteValue {
  readonly text: string;
}

export interface VaultValueByKind {
  readonly secret: SecretValue;
  readonly login: LoginValue;
  readonly card: CardValue;
  readonly bank_account: BankAccountValue;
  readonly identity: IdentityValue;
  readonly address: AddressValue;
  readonly note: NoteValue;
}

export type VaultEntryValue = {
  [K in VaultEntryKind]: { readonly kind: K } & VaultValueByKind[K];
}[VaultEntryKind];

export interface LoginMetadata {
  readonly username_hint: string;
  readonly has_totp: boolean;
}

export interface CardMetadata {
  readonly brand: string;
  readonly last4: string;
  readonly exp_month: number;
  readonly exp_year: number;
}

export interface BankAccountMetadata {
  readonly iban_last4: string;
  readonly country: string;
}

export interface IdentityMetadata {
  readonly label_hint: string;
}

export interface AddressMetadata {
  readonly city: string;
  readonly country: string;
}

export type NoteMetadata = Record<string, never>;

export interface VaultMetadataByKind {
  readonly secret: Record<string, never>;
  readonly login: LoginMetadata;
  readonly card: CardMetadata;
  readonly bank_account: BankAccountMetadata;
  readonly identity: IdentityMetadata;
  readonly address: AddressMetadata;
  readonly note: NoteMetadata;
}

export type VaultItemMetadata =
  | LoginMetadata
  | CardMetadata
  | BankAccountMetadata
  | IdentityMetadata
  | AddressMetadata
  | Record<string, never>;

export const VAULT_KIND_FIELDS = {
  secret: ["token"],
  login: ["username", "password", "totp_seed"],
  card: ["number", "exp_month", "exp_year", "holder"],
  bank_account: ["iban", "bic", "holder"],
  identity: ["full_name", "birth_date", "document_type", "document_number", "nationality"],
  address: ["name", "line1", "line2", "postal_code", "city", "region", "country", "phone", "email"],
  note: ["text"],
} as const satisfies Readonly<Record<VaultEntryKind, readonly string[]>>;

export type VaultKindField = (typeof VAULT_KIND_FIELDS)[VaultEntryKind][number];

export function isVaultKind(value: string): value is VaultKind {
  return (VAULT_KINDS as readonly string[]).includes(value);
}

export function isVaultEntryKind(value: string): value is VaultEntryKind {
  return (VAULT_ENTRY_KINDS as readonly string[]).includes(value);
}

export function isStructuredKind(value: string): value is StructuredKind {
  return (STRUCTURED_KINDS as readonly string[]).includes(value);
}

export function isPersonalOnlyKind(value: string): value is PersonalOnlyKind {
  return (PERSONAL_ONLY_KINDS as readonly string[]).includes(value);
}

export function needsFreshAuthToReveal(kind: string): boolean {
  return (FRESH_AUTH_KINDS as readonly string[]).includes(kind);
}

export function usableInConnectorSteps(kind: string): boolean {
  return (CONNECTOR_STEP_KINDS as readonly string[]).includes(kind);
}

export function fieldsOfKind(kind: string): readonly string[] {
  return isVaultEntryKind(kind) ? VAULT_KIND_FIELDS[kind] : [];
}
