import type { TranslationKey } from "@/lib/i18n";

export const IMPORT_FORMATS = ["chrome", "1password", "bitwarden"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const SIGNATURES: Readonly<Record<ImportFormat, readonly string[]>> = {
  chrome: ["name", "url", "username", "password"],
  "1password": ["title", "url", "username", "password"],
  bitwarden: ["login_uri", "login_username", "login_password"],
};

export function headerColumns(csv: string): string[] {
  const first = csv.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return first.split(",").map((column) => column.trim().replace(/^"|"$/g, "").toLowerCase());
}

export function detectFormat(csv: string): ImportFormat | null {
  const columns = headerColumns(csv);
  for (const format of ["bitwarden", "1password", "chrome"] as const)
    if (SIGNATURES[format].every((column) => columns.includes(column))) return format;
  return null;
}

export type ImportRowStatus = "new" | "created" | "exists" | "invalid";

export interface ImportRowWire {
  name?: string;
  origin?: string | null;
  username_hint?: string | null;
  has_totp?: boolean;
  status?: string;
  reason?: string | null;
}

export interface ImportPreviewWire {
  rows?: readonly ImportRowWire[];
  created?: number;
}

export interface ImportRow {
  name: string;
  origin: string | null;
  usernameHint: string | null;
  hasTotp: boolean;
  status: ImportRowStatus;
  reason: string | null;
}

const WIRE_STATUS: Readonly<Record<string, ImportRowStatus>> = {
  create: "new",
  created: "created",
  exists: "exists",
  invalid: "invalid",
};

export function importRows(wire: ImportPreviewWire): ImportRow[] {
  return (wire.rows ?? []).map((row) => ({
    name: row.name ?? "",
    origin: row.origin ?? null,
    usernameHint: row.username_hint ?? null,
    hasTotp: row.has_totp === true,
    status: WIRE_STATUS[row.status ?? ""] ?? "invalid",
    reason: row.reason ?? null,
  }));
}

export function importCounts(rows: readonly ImportRow[]): Record<ImportRowStatus, number> {
  const counts: Record<ImportRowStatus, number> = { new: 0, created: 0, exists: 0, invalid: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export const ROW_STATUS_KEYS: Readonly<Record<ImportRowStatus, TranslationKey>> = {
  new: "vault.import.status.new",
  exists: "vault.import.status.exists",
  invalid: "vault.import.status.invalid",
  created: "vault.import.status.created",
};

export function importFileProblem(file: { size: number; name: string }): TranslationKey | null {
  if (file.size === 0) return "vault.import.error.empty";
  if (file.size > IMPORT_MAX_BYTES) return "vault.import.error.tooLarge";
  return /\.csv$/i.test(file.name) ? null : "vault.import.error.notCsv";
}

export function importErrorKey(error: unknown): TranslationKey {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (status === 403) return "vault.error.forbidden";
  if (status === 400 || status === 422) return "vault.import.error.format";
  if (status === 413) return "vault.import.error.tooLarge";
  return "vault.error.generic";
}
