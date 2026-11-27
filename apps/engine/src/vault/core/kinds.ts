import { totpSeedFrom } from "@shared/totp.ts";
import {
  type AddressValue,
  type BankAccountValue,
  type CardValue,
  type IdentityValue,
  isVaultEntryKind,
  type LoginValue,
  type NoteValue,
  type SecretValue,
  type VaultEntryKind,
  type VaultEntryValue,
  type VaultItemMetadata,
} from "@shared/vault-kinds.ts";
import {
  bicValid,
  cardBrand,
  expiryInFuture,
  ibanValid,
  luhnValid,
  normalizeIban,
  normalizeOrigin,
  panDigits,
} from "@shared/vault-validate.ts";
import { z } from "zod";

const MAX_ORIGINS = 20;
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

function fullYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

const SecretSchema = z.object({ token: z.string().min(1).max(16384) }).strict();

const LoginSchema = z
  .object({
    username: z.string().min(1).max(1024),
    password: z.string().min(1).max(16384),
    totp_seed: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .transform((value, ctx) => {
    if (value.totp_seed === undefined || value.totp_seed.trim() === "") {
      return { username: value.username, password: value.password };
    }
    const seed = totpSeedFrom(value.totp_seed);
    if (seed === null) {
      ctx.addIssue({
        code: "custom",
        path: ["totp_seed"],
        message:
          "the one-time code key is a base32 seed or an otpauth:// link with 6 digits, 30 seconds and SHA1",
      });
      return z.NEVER;
    }
    return { username: value.username, password: value.password, totp_seed: seed };
  });

const CardSchema = z
  .object({
    number: z.string().min(12).max(40),
    exp_month: z.coerce.number().int().min(1).max(12),
    exp_year: z.coerce.number().int().min(0).max(2200),
    holder: text(200),
  })
  .strict()
  .transform((value, ctx) => {
    const number = panDigits(value.number);
    if (!/^\d{12,19}$/.test(number) || !luhnValid(number)) {
      ctx.addIssue({ code: "custom", path: ["number"], message: "the card number is not valid" });
      return z.NEVER;
    }
    const exp_year = fullYear(value.exp_year);
    return { number, exp_month: value.exp_month, exp_year, holder: value.holder };
  });

const BankAccountSchema = z
  .object({
    iban: z.string().min(15).max(42),
    bic: optionalText(11),
    holder: text(200),
  })
  .strict()
  .transform((value, ctx) => {
    const iban = normalizeIban(value.iban);
    if (!ibanValid(iban)) {
      ctx.addIssue({ code: "custom", path: ["iban"], message: "the IBAN is not valid" });
      return z.NEVER;
    }
    const bic = value.bic ? value.bic.toUpperCase() : undefined;
    if (bic !== undefined && !bicValid(bic)) {
      ctx.addIssue({ code: "custom", path: ["bic"], message: "the BIC is not valid" });
      return z.NEVER;
    }
    return { iban, ...(bic ? { bic } : {}), holder: value.holder };
  });

const IdentitySchema = z
  .object({
    full_name: text(200),
    birth_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
      .optional(),
    document_type: optionalText(100),
    document_number: optionalText(100),
    nationality: optionalText(100),
  })
  .strict();

const AddressSchema = z
  .object({
    name: optionalText(200),
    line1: text(300),
    line2: optionalText(300),
    postal_code: text(20),
    city: text(200),
    region: optionalText(200),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "use the two-letter country code")
      .transform((value) => value.toUpperCase()),
    phone: optionalText(50),
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();

const NoteSchema = z.object({ text: z.string().min(1).max(20000) }).strict();

export const KIND_VALUE_SCHEMAS = {
  secret: SecretSchema,
  login: LoginSchema,
  card: CardSchema,
  bank_account: BankAccountSchema,
  identity: IdentitySchema,
  address: AddressSchema,
  note: NoteSchema,
} as const satisfies Record<VaultEntryKind, z.ZodType>;

function withoutEmpty(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

function issueMessage(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) return "the value is not valid";
  if (issue.code === "unrecognized_keys") {
    return issue.keys.includes("cvv") || issue.keys.includes("cvc")
      ? "the vault never stores a card's security code"
      : `unknown field ${issue.keys.join(", ")}`;
  }
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseKindValue(
  kind: string,
  raw: unknown,
  now: Date,
): { ok: true; value: VaultEntryValue } | { ok: false; message: string } {
  if (!isVaultEntryKind(kind)) return { ok: false, message: `a ${kind} has no value of its own` };
  const parsed = KIND_VALUE_SCHEMAS[kind].safeParse(withoutEmpty(raw));
  if (!parsed.success) return { ok: false, message: issueMessage(parsed.error) };
  const value = { kind, ...parsed.data } as VaultEntryValue;
  if (value.kind === "card" && !expiryInFuture(value.exp_month, value.exp_year, now)) {
    return { ok: false, message: "exp_year: the card has expired" };
  }
  return { ok: true, value };
}

function hint(value: string): string {
  return `${value.slice(0, 2)}…`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}.`)
    .join(" ");
}

export function metadataOf(value: VaultEntryValue): VaultItemMetadata {
  switch (value.kind) {
    case "secret":
    case "note":
      return {};
    case "login":
      return { username_hint: hint(value.username), has_totp: value.totp_seed !== undefined };
    case "card":
      return {
        brand: cardBrand(value.number),
        last4: value.number.slice(-4),
        exp_month: value.exp_month,
        exp_year: value.exp_year,
      };
    case "bank_account":
      return { iban_last4: value.iban.slice(-4), country: value.iban.slice(0, 2) };
    case "identity":
      return { label_hint: initials(value.full_name) };
    case "address":
      return { city: value.city, country: value.country };
  }
}

export function plainOf(value: VaultEntryValue): Record<string, unknown> {
  const { kind: _kind, ...rest } = value;
  return rest;
}

export function secretsOf(value: VaultEntryValue): string[] {
  switch (value.kind) {
    case "secret":
      return [value.token];
    case "login":
      return [value.password, ...(value.totp_seed ? [value.totp_seed] : [])];
    case "card":
      return [value.number];
    case "bank_account":
      return [value.iban];
    case "identity":
      return value.document_number ? [value.document_number] : [];
    case "address":
    case "note":
      return [];
  }
}

export function normalizeOrigins(raw: readonly string[]): string[] | string {
  if (raw.length > MAX_ORIGINS) return `a login keeps at most ${MAX_ORIGINS} websites`;
  const out = new Set<string>();
  for (const entry of raw) {
    const origin = normalizeOrigin(entry);
    if (origin === null) {
      return `${entry} is not a website address; use https:// (http:// only for localhost)`;
    }
    out.add(origin);
  }
  return [...out];
}

export type {
  AddressValue,
  BankAccountValue,
  CardValue,
  IdentityValue,
  LoginValue,
  NoteValue,
  SecretValue,
};
