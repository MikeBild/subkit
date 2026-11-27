import type { VaultItem, VaultItemCreate } from "../engine-client/vault.ts";

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

export interface EntryPrompts {
  readonly hidden: (label: string) => Promise<string>;
  readonly visible: (label: string) => Promise<string>;
}

interface FieldSpec {
  readonly name: string;
  readonly label: string;
  readonly hidden?: boolean;
  readonly optional?: boolean;
  readonly numeric?: boolean;
}

const STRUCTURED_FIELDS: Readonly<Record<string, readonly FieldSpec[]>> = {
  card: [
    { name: "number", label: "Card number", hidden: true },
    { name: "exp_month", label: "Expiry month (1-12)", numeric: true },
    { name: "exp_year", label: "Expiry year (e.g. 2030)", numeric: true },
    { name: "holder", label: "Name on the card" },
  ],
  bank_account: [
    { name: "iban", label: "IBAN", hidden: true },
    { name: "bic", label: "BIC (optional)", optional: true },
    { name: "holder", label: "Account holder" },
  ],
  identity: [
    { name: "full_name", label: "Full name" },
    { name: "birth_date", label: "Date of birth, YYYY-MM-DD (optional)", optional: true },
    { name: "document_type", label: "Document type (optional)", optional: true },
    { name: "document_number", label: "Document number (optional)", hidden: true, optional: true },
    { name: "nationality", label: "Nationality (optional)", optional: true },
  ],
  address: [
    { name: "name", label: "Name (optional)", optional: true },
    { name: "line1", label: "Street and number" },
    { name: "line2", label: "Address line 2 (optional)", optional: true },
    { name: "postal_code", label: "Postal code" },
    { name: "city", label: "City" },
    { name: "region", label: "Region (optional)", optional: true },
    { name: "country", label: "Country code (e.g. DE)" },
    { name: "phone", label: "Phone (optional)", optional: true },
    { name: "email", label: "Email (optional)", optional: true },
  ],
  note: [{ name: "text", label: "Note", hidden: true }],
};

export function isEntryKind(value: string): value is EntryKind {
  return (ENTRY_KINDS as readonly string[]).includes(value);
}

export function promptHidden(
  label: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string> {
  output.write(`${label} `);
  input.setRawMode?.(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    input.on("data", onData);
  });
}

export function terminalPrompts(): EntryPrompts {
  return {
    hidden: (label) => promptHidden(label),
    visible: async (label) => globalThis.prompt?.(label) ?? "",
  };
}

export async function promptStructuredValue(
  kind: string,
  prompts: EntryPrompts,
): Promise<Record<string, string | number>> {
  const specs = STRUCTURED_FIELDS[kind];
  if (!specs) throw new Error(`a ${kind} has no structured fields`);
  const value: Record<string, string | number> = {};
  for (const spec of specs) {
    const raw = (await (spec.hidden ? prompts.hidden : prompts.visible)(`${spec.label}:`)).trim();
    if (!raw) {
      if (spec.optional) continue;
      throw new Error(`${spec.label} is required`);
    }
    value[spec.name] = spec.numeric ? Number(raw) : raw;
  }
  return value;
}

export function structuredValueFromJson(raw: string): Record<string, string | number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `stdin holds the fields as one JSON object (${error instanceof Error ? error.message : "parse error"})`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin holds the fields as one JSON object");
  }
  const out: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "number") out[key] = item;
  }
  return out;
}

export function originsArg(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function loginBody(
  password: string,
  username: string,
  options: { totp_seed?: string | undefined; origins?: string[] | undefined },
): Pick<VaultItemCreate, "username" | "password" | "totp_seed" | "origins"> {
  return {
    username,
    password,
    ...(options.totp_seed ? { totp_seed: options.totp_seed } : {}),
    ...(options.origins ? { origins: options.origins } : {}),
  };
}

export function maskedSummary(item: Pick<VaultItem, "kind" | "metadata" | "origins">): string {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  switch (item.kind) {
    case "login": {
      const parts = [String(meta.username_hint ?? "")];
      if (meta.has_totp) parts.push("one-time code");
      if (item.origins.length > 0) parts.push(item.origins.join(" "));
      return parts.filter(Boolean).join("  ");
    }
    case "card": {
      const month = String(meta.exp_month ?? "").padStart(2, "0");
      return `${meta.brand ?? "card"} •••• ${meta.last4 ?? ""}  ${month}/${meta.exp_year ?? ""}`;
    }
    case "bank_account":
      return `${meta.country ?? ""} •••• ${meta.iban_last4 ?? ""}`;
    case "identity":
      return String(meta.label_hint ?? "");
    case "address":
      return [meta.city, meta.country].filter(Boolean).join(", ");
    default:
      return "";
  }
}
