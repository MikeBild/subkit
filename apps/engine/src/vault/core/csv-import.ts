import { vaultItemNameFrom } from "@shared/vault-handle.ts";
import { normalizeOrigin } from "@shared/vault-validate.ts";
import { parseKindValue } from "./kinds.ts";

export type CsvImportFormat = "chrome" | "1password" | "bitwarden";

export interface CsvLogin {
  readonly row: number;
  readonly name: string;
  readonly origin: string | null;
  readonly website_ignored: boolean;
  readonly username: string;
  readonly password: string;
  readonly totp_seed?: string;
  readonly note: string | null;
}

export interface CsvRejectedRow {
  readonly row: number;
  readonly title: string;
  readonly reason: string;
}

export interface ParsedLoginCsv {
  readonly format: CsvImportFormat;
  readonly logins: CsvLogin[];
  readonly rejected: CsvRejectedRow[];
}

interface ColumnMap {
  readonly title: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly totp?: string;
  readonly note?: string;
  readonly type?: string;
}

const FORMATS: Readonly<Record<CsvImportFormat, ColumnMap>> = {
  chrome: { title: "name", url: "url", username: "username", password: "password", note: "note" },
  "1password": {
    title: "title",
    url: "url",
    username: "username",
    password: "password",
    totp: "otpauth",
    note: "notes",
  },
  bitwarden: {
    title: "name",
    url: "login_uri",
    username: "login_username",
    password: "login_password",
    totp: "login_totp",
    note: "notes",
    type: "type",
  },
};

export const CSV_IMPORT_MAX_ROWS = 5000;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index] as string;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

export function detectFormat(header: readonly string[]): CsvImportFormat | null {
  const columns = new Set(header.map((name) => name.trim().toLowerCase()));
  if (columns.has("login_password") && columns.has("login_uri")) return "bitwarden";
  if (columns.has("title") && columns.has("password")) return "1password";
  if (columns.has("name") && columns.has("url") && columns.has("password")) return "chrome";
  return null;
}

function cellOf(header: readonly string[], cells: readonly string[], column: string | undefined) {
  if (column === undefined) return "";
  const index = header.indexOf(column);
  return index < 0 ? "" : (cells[index] ?? "").trim();
}

function firstUrl(raw: string): string {
  return raw.split(/[\s,]+/).find((part) => part.length > 0) ?? "";
}

function titleFor(title: string, origin: string | null, row: number): string {
  if (title) return title;
  if (origin) return new URL(origin).hostname.replace(/^www\./, "");
  return `login-${row}`;
}

export function parseLoginCsv(
  text: string,
  requested: CsvImportFormat | undefined,
  now: Date,
): ParsedLoginCsv | { error: string } {
  const [rawHeader, ...body] = parseCsv(text);
  if (!rawHeader) return { error: "the file is empty" };
  if (body.length > CSV_IMPORT_MAX_ROWS) {
    return { error: `the file has more than ${CSV_IMPORT_MAX_ROWS} rows` };
  }
  const header = rawHeader.map((name) => name.trim().toLowerCase());
  const format = requested ?? detectFormat(header);
  if (!format) return { error: "the columns match no Chrome, 1Password or Bitwarden export" };
  const columns = FORMATS[format];
  if (!header.includes(columns.password)) {
    return { error: `the ${format} export needs a ${columns.password} column` };
  }
  const logins: CsvLogin[] = [];
  const rejected: CsvRejectedRow[] = [];
  const names = new Set<string>();
  body.forEach((cells, offset) => {
    const row = offset + 2;
    const type = cellOf(header, cells, columns.type);
    const rawUrl = firstUrl(cellOf(header, cells, columns.url));
    const origin = rawUrl ? normalizeOrigin(rawUrl) : null;
    const title = titleFor(cellOf(header, cells, columns.title), origin, row);
    if (type && type.toLowerCase() !== "login") {
      rejected.push({ row, title, reason: `a ${type} entry is not a login` });
      return;
    }
    const parsed = parseKindValue(
      "login",
      {
        username: cellOf(header, cells, columns.username),
        password: cellOf(header, cells, columns.password),
        totp_seed: cellOf(header, cells, columns.totp),
      },
      now,
    );
    if (!parsed.ok || parsed.value.kind !== "login") {
      rejected.push({ row, title, reason: parsed.ok ? "not a login" : parsed.message });
      return;
    }
    const base = vaultItemNameFrom(title);
    let name = base;
    for (let suffix = 2; names.has(name); suffix++) name = `${base.slice(0, 58)}-${suffix}`;
    names.add(name);
    const note = cellOf(header, cells, columns.note);
    logins.push({
      row,
      name,
      origin,
      website_ignored: rawUrl !== "" && origin === null,
      username: parsed.value.username,
      password: parsed.value.password,
      ...(parsed.value.totp_seed ? { totp_seed: parsed.value.totp_seed } : {}),
      note: note ? note.slice(0, 500) : null,
    });
  });
  return { format, logins, rejected };
}
