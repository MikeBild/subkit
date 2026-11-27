import {
  bicValid,
  type CardBrand,
  cardBrand,
  expiryInFuture,
  ibanValid,
  isCardNumber,
  luhnValid,
  normalizeIban,
  normalizeOrigin,
  panDigits,
} from "@shared/vault-validate.ts";
import type { TranslationKey } from "@/lib/i18n";

export const ENTRY_KINDS = [
  "secret",
  "login",
  "card",
  "bank_account",
  "identity",
  "address",
  "note",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const PERSONAL_ONLY_KINDS = ["card", "bank_account", "identity"] as const;
export const FRESH_AUTH_KINDS = ["card", "bank_account"] as const;

export type Scope = "workspace" | "person";

export function isPersonalOnly(kind: string): boolean {
  return (PERSONAL_ONLY_KINDS as readonly string[]).includes(kind);
}

export function needsFreshAuth(kind: string): boolean {
  return (FRESH_AUTH_KINDS as readonly string[]).includes(kind);
}

export function scopeFor(kind: string, requested: Scope): Scope {
  return isPersonalOnly(kind) ? "person" : requested;
}

export function scopeChoices(kind: string, canWriteWorkspace: boolean): Scope[] {
  if (isPersonalOnly(kind) || !canWriteWorkspace) return ["person"];
  return ["workspace", "person"];
}

export function scopeNoteKey(kind: string, canWriteWorkspace: boolean): TranslationKey | null {
  if (isPersonalOnly(kind)) return "vault.field.scopePersonalOnly";
  return canWriteWorkspace ? null : "vault.field.scopeReadOnly";
}

export const ENTRY_FIELDS = {
  secret: [],
  login: ["totp", "origins"],
  card: ["number", "expiry", "holder"],
  bank_account: ["iban", "bic", "holder"],
  identity: ["full_name", "birth_date", "document_type", "document_number", "nationality"],
  address: ["name", "line1", "line2", "postal_code", "city", "region", "country", "phone", "email"],
  note: ["text"],
} as const satisfies Readonly<Record<EntryKind, readonly string[]>>;

export type EntryField = (typeof ENTRY_FIELDS)[EntryKind][number];

const REQUIRED: Readonly<Partial<Record<EntryKind, readonly EntryField[]>>> = {
  card: ["number", "expiry", "holder"],
  bank_account: ["iban", "holder"],
  identity: ["full_name"],
  address: ["line1", "postal_code", "city", "country"],
  note: ["text"],
};

const KEPT_ON_CLEAR: ReadonlySet<string> = new Set(["origins"]);

export function isRequired(kind: EntryKind, field: EntryField): boolean {
  return REQUIRED[kind]?.includes(field) ?? false;
}

export interface Problem {
  key: TranslationKey;
  values?: Record<string, string>;
}

export type FieldValues = Readonly<Record<string, string>>;

export function clearedFields(fields: FieldValues | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields ?? {}))
    if (KEPT_ON_CLEAR.has(field)) kept[field] = value;
  return kept;
}

export function originLines(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function normalizedOrigins(raw: string): { origins: string[]; invalid: string | null } {
  const origins: string[] = [];
  for (const line of originLines(raw)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `https://${line}`;
    const origin = normalizeOrigin(withScheme);
    if (origin === null) return { origins, invalid: line };
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid: null };
}

export interface Expiry {
  month: number;
  year: number;
}

export function parseExpiry(raw: string): Expiry | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  const month = Number(match[1]);
  const year = match[2].length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return month >= 1 && month <= 12 ? { month, year } : null;
}

export function expiryLabel(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}`;
}

export function cardNumberProblem(raw: string): Problem | null {
  const digits = panDigits(raw);
  if (digits === "") return { key: "vault.card.numberMissing" };
  if (!/^\d+$/.test(digits)) return { key: "vault.card.numberDigits" };
  if (digits.length < 13 || digits.length > 19) return { key: "vault.card.numberLength" };
  if (!luhnValid(digits)) return { key: "vault.card.numberChecksum" };
  return isCardNumber(digits) ? null : { key: "vault.card.numberUnknown" };
}

export function detectedBrand(raw: string): CardBrand | null {
  const digits = panDigits(raw);
  if (digits.length < 2) return null;
  const brand = cardBrand(digits);
  return brand === "unknown" ? null : brand;
}

export function expiryProblem(raw: string, now: Date): Problem | null {
  if (raw.trim() === "") return { key: "vault.card.expiryMissing" };
  const expiry = parseExpiry(raw);
  if (!expiry) return { key: "vault.card.expiryFormat" };
  return expiryInFuture(expiry.month, expiry.year, now) ? null : { key: "vault.card.expired" };
}

export function ibanProblem(raw: string): Problem | null {
  const iban = normalizeIban(raw);
  if (iban === "") return { key: "vault.bank.ibanMissing" };
  return ibanValid(iban) ? null : { key: "vault.bank.ibanInvalid" };
}

export function bicProblem(raw: string): Problem | null {
  if (raw.trim() === "") return null;
  return bicValid(raw) ? null : { key: "vault.bank.bicInvalid" };
}

const BASE32 = /^[A-Z2-7]+$/;

export function normalizeSeed(seed: string): string {
  return seed.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
}

export interface TotpSetup {
  secret: string;
  digits: number;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  account: string | null;
  issuer: string | null;
}

export function parseTotp(raw: string): TotpSetup | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    const secret = normalizeSeed(trimmed);
    if (secret.length < 16 || !BASE32.test(secret)) return null;
    return { secret, digits: 6, period: 30, algorithm: "SHA1", account: null, issuer: null };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "totp") return null;
  const secret = normalizeSeed(url.searchParams.get("secret") ?? "");
  if (secret.length < 16 || !BASE32.test(secret)) return null;
  const digits = Number(url.searchParams.get("digits") ?? 6);
  const period = Number(url.searchParams.get("period") ?? 30);
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") return null;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return null;
  if (!Number.isInteger(period) || period <= 0) return null;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const colon = label.indexOf(":");
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim() || null;
  const issuer =
    url.searchParams.get("issuer") ?? (colon >= 0 ? label.slice(0, colon).trim() : null);
  return { secret, digits, period, algorithm, account, issuer: issuer || null };
}

export function totpProblem(raw: string): Problem | null {
  if (raw.trim() === "") return null;
  const setup = parseTotp(raw);
  if (!setup) return { key: "vault.totp.invalid" };
  return setup.digits === 6 && setup.period === 30 && setup.algorithm === "SHA1"
    ? null
    : { key: "vault.totp.unsupported" };
}

export function originsProblem(raw: string): Problem | null {
  const { invalid } = normalizedOrigins(raw);
  return invalid === null ? null : { key: "vault.origins.invalid", values: { origin: invalid } };
}

const COUNTRY = /^[A-Za-z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const REQUIRED_PROBLEM: Problem = { key: "vault.entry.required" };

export function fieldProblems(
  kind: EntryKind,
  fields: FieldValues | undefined,
  now: Date,
): Partial<Record<EntryField, Problem>> {
  const value = (field: EntryField) => (fields?.[field] ?? "").trim();
  const problems: Partial<Record<EntryField, Problem>> = {};
  const set = (field: EntryField, problem: Problem | null) => {
    if (problem) problems[field] = problem;
  };
  for (const field of REQUIRED[kind] ?? []) if (value(field) === "") set(field, REQUIRED_PROBLEM);
  if (kind === "login") {
    set("totp", totpProblem(value("totp")));
    set("origins", originsProblem(fields?.origins ?? ""));
  }
  if (kind === "card") {
    set("number", cardNumberProblem(value("number")));
    set("expiry", expiryProblem(value("expiry"), now));
  }
  if (kind === "bank_account") {
    set("iban", ibanProblem(value("iban")));
    set("bic", bicProblem(value("bic")));
  }
  if (kind === "identity" && value("birth_date") !== "" && !DATE.test(value("birth_date")))
    set("birth_date", { key: "vault.identity.birthDateInvalid" });
  if (kind === "address") {
    if (value("country") !== "" && !COUNTRY.test(value("country")))
      set("country", { key: "vault.address.countryInvalid" });
    if (value("email") !== "" && !EMAIL.test(value("email")))
      set("email", { key: "vault.address.emailInvalid" });
  }
  return problems;
}

function optional(fields: FieldValues | undefined, names: readonly string[]) {
  const out: Record<string, string> = {};
  for (const name of names) {
    const text = (fields?.[name] ?? "").trim();
    if (text !== "") out[name] = text;
  }
  return out;
}

export type StructuredValue = Record<string, string | number>;

export function structuredValue(kind: EntryKind, fields: FieldValues | undefined): StructuredValue {
  const text = (name: string) => (fields?.[name] ?? "").trim();
  switch (kind) {
    case "card": {
      const expiry = parseExpiry(text("expiry"));
      return {
        number: panDigits(text("number")),
        exp_month: expiry?.month ?? 0,
        exp_year: expiry?.year ?? 0,
        holder: text("holder"),
      };
    }
    case "bank_account":
      return {
        iban: normalizeIban(text("iban")),
        holder: text("holder"),
        ...(text("bic") ? { bic: text("bic").toUpperCase() } : {}),
      };
    case "identity":
      return optional(fields, ENTRY_FIELDS.identity);
    case "address": {
      const address = optional(fields, ENTRY_FIELDS.address);
      return address.country ? { ...address, country: address.country.toUpperCase() } : address;
    }
    case "note":
      return { text: fields?.text ?? "" };
    default:
      return {};
  }
}

export function loginExtras(fields: FieldValues | undefined): {
  totp_seed?: string;
  origins?: string[];
} {
  const totp = parseTotp(fields?.totp ?? "");
  const { origins } = normalizedOrigins(fields?.origins ?? "");
  return {
    ...(totp ? { totp_seed: totp.secret } : {}),
    ...(origins.length > 0 ? { origins } : {}),
  };
}

export type Metadata = Readonly<Record<string, unknown>>;

export function metadataOf(item: { fields?: unknown; metadata?: unknown }): Metadata {
  const isRecord = (value: unknown): value is Metadata =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRecord(item.metadata)) return item.metadata;
  return isRecord(item.fields) ? item.fields : {};
}

export function originsOf(item: { origins?: unknown }): string[] {
  return Array.isArray(item.origins)
    ? item.origins.filter((origin): origin is string => typeof origin === "string")
    : [];
}

const BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  maestro: "Maestro",
};

export function brandName(brand: string | null | undefined): string | null {
  return brand ? (BRAND_NAMES[brand.toLowerCase()] ?? null) : null;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export interface MaskedLine {
  key: TranslationKey;
  values: Record<string, string>;
}

export function maskedLine(kind: string, meta: Metadata): MaskedLine | null {
  switch (kind) {
    case "card": {
      const last4 = str(meta.last4);
      if (!last4) return null;
      const brand = brandName(str(meta.brand));
      const month = num(meta.exp_month);
      const year = num(meta.exp_year);
      const values = { brand: brand ?? "", last4, expiry: month ? expiryLabel(month, year) : "" };
      if (!brand) return { key: "vault.masked.cardNoBrand", values };
      return { key: month ? "vault.masked.card" : "vault.masked.cardNoExpiry", values };
    }
    case "bank_account": {
      const last4 = str(meta.iban_last4);
      return last4 ? { key: "vault.masked.iban", values: { last4 } } : null;
    }
    case "login": {
      const hint = str(meta.username_hint);
      if (!hint) return null;
      return {
        key: meta.has_totp === true ? "vault.masked.loginTotp" : "vault.masked.login",
        values: { hint },
      };
    }
    case "identity": {
      const hint = str(meta.label_hint);
      return hint ? { key: "vault.masked.identity", values: { hint } } : null;
    }
    case "address": {
      const city = str(meta.city);
      return city
        ? { key: "vault.masked.address", values: { city, country: str(meta.country) } }
        : null;
    }
    default:
      return null;
  }
}

export function cardExpired(meta: Metadata, now: Date): boolean {
  const month = num(meta.exp_month);
  const year = num(meta.exp_year);
  return month > 0 && !expiryInFuture(month, year, now);
}

export function isFreshAuthRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const details = "details" in error ? error.details : null;
  const reason =
    typeof details === "object" && details !== null && "reason" in details
      ? String(details.reason)
      : "";
  return /reauth|fresh_auth|recent_auth|auth_time/i.test(`${code} ${reason}`);
}
