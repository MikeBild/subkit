export type ParseFileFormat = "csv" | "xlsx" | "pdf" | "docx" | "zip";

export const PARSE_FILE_SOURCE_MISSING = "parse_file_source_missing";
export const PARSE_FILE_UNSUPPORTED_FORMAT = "parse_file_unsupported_format";
export const PARSE_FILE_SHEET_MISSING = "parse_file_sheet_missing";
export const PARSE_FILE_TOO_LARGE = "parse_file_too_large";
export const PARSE_FILE_FAILED = "parse_file_failed";
export const PARSE_FILE_MAX_BYTES = 25 * 1024 * 1024;

const DEFAULT_MAX_ROWS = 10_000;

export interface ParseFileFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ParseFileDecision<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ParseFileFailure };

export type ParsedFile =
  | { format: "csv"; rows: unknown[]; row_count: number; truncated: boolean }
  | {
      format: "xlsx";
      sheet: string;
      sheets: string[];
      rows: unknown[];
      row_count: number;
      truncated: boolean;
    }
  | { format: "pdf"; text: string; pages: number }
  | { format: "docx"; markdown: string }
  | {
      format: "zip";
      text: string;
      entries: Array<{ path: string; format: string }>;
      skipped: Array<{ path: string; reason: string }>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail<T>(code: string, message: string, details?: Record<string, unknown>) {
  return {
    ok: false,
    failure: { code, message, ...(details ? { details } : {}) },
  } as ParseFileDecision<T>;
}

function at(root: unknown, path: string): unknown {
  let cur = root;
  for (const segment of path.split(".")) {
    if (segment === "") continue;
    if (!isRecord(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

function fileIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.$file === "string" && value.$file.length > 0) return value.$file;
  return isRecord(value.file) ? fileIdOf(value.file) : null;
}

export function parseFileSource(
  scope: Readonly<Record<string, unknown>>,
  source: string,
): ParseFileDecision<string> {
  const id = fileIdOf(at(scope, source));
  if (id) return { ok: true, value: id };
  return fail(
    PARSE_FILE_SOURCE_MISSING,
    `No file found at \`${source}\`. Point \`file.source\` at a file reference such as \`download.data\` or \`$input.invoice\`.`,
    { source },
  );
}

function looksLikeCsv(filename: string, contentType: string | null): boolean {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return (
    filename.toLowerCase().endsWith(".csv") || type === "text/csv" || type === "application/csv"
  );
}

export function parseFileFormat(input: {
  declared: ParseFileFormat | undefined;
  filename: string;
  content_type: string | null;
  detected: string | null;
}): ParseFileDecision<ParseFileFormat> {
  if (input.declared) return { ok: true, value: input.declared };
  if (looksLikeCsv(input.filename, input.content_type)) return { ok: true, value: "csv" };
  const detected = input.detected;
  if (detected === "xlsx" || detected === "pdf" || detected === "docx" || detected === "zip")
    return { ok: true, value: detected };
  return fail(
    PARSE_FILE_UNSUPPORTED_FORMAT,
    `The file "${input.filename}" is not a CSV, XLSX, PDF, DOCX or ZIP file. Set \`file.format\` if it is one of them.`,
    { detected },
  );
}

export function parseFileSizeRefusal(sizeBytes: number): ParseFileFailure | null {
  if (sizeBytes <= PARSE_FILE_MAX_BYTES) return null;
  return {
    code: PARSE_FILE_TOO_LARGE,
    message: `The file is ${sizeBytes} bytes; a parse-file step reads at most ${PARSE_FILE_MAX_BYTES} bytes.`,
    details: { size_bytes: sizeBytes, max_bytes: PARSE_FILE_MAX_BYTES },
  };
}

export function parseFileRowLimit(maxRows: number | undefined): number {
  return maxRows ?? DEFAULT_MAX_ROWS;
}

function limitRows<T>(rows: T[], maxRows: number | undefined) {
  const limit = parseFileRowLimit(maxRows);
  return { rows: rows.slice(0, limit), row_count: rows.length, truncated: rows.length > limit };
}

export type ParsedTable =
  | {
      ok: true;
      format: "csv" | "xlsx";
      rows: unknown[];
      row_count: number;
      truncated: boolean;
      sheet?: string | undefined;
      sheets?: string[] | undefined;
    }
  | {
      ok: false;
      reason: "malformed";
      message: string;
      errors: ReadonlyArray<{ code: string; row: number; message: string }>;
    }
  | { ok: false; reason: "sheet_missing"; sheets: string[] };

export function parseFileTable(
  table: ParsedTable,
  requestedSheet: string | undefined,
): ParseFileDecision<ParsedFile> {
  if (!table.ok) {
    if (table.reason === "malformed")
      return fail(PARSE_FILE_FAILED, table.message, { errors: table.errors });
    return fail(
      PARSE_FILE_SHEET_MISSING,
      requestedSheet === undefined
        ? "The spreadsheet has no sheets."
        : `The spreadsheet has no sheet named "${requestedSheet}".`,
      { sheets: table.sheets },
    );
  }
  const rows = { rows: table.rows, row_count: table.row_count, truncated: table.truncated };
  if (table.format === "csv") return { ok: true, value: { format: "csv", ...rows } };
  return {
    ok: true,
    value: { format: "xlsx", sheet: table.sheet ?? "", sheets: table.sheets ?? [], ...rows },
  };
}

function limitTable(
  parsed: { rows: unknown[]; row_count: number; truncated: boolean },
  maxRows: number | undefined,
) {
  const limited = limitRows(parsed.rows, maxRows);
  return {
    rows: limited.rows,
    row_count: Math.max(parsed.row_count, limited.row_count),
    truncated: parsed.truncated || limited.truncated,
  };
}

export function parseFileOutput(
  parsed: ParsedFile,
  options: { filename: string; max_rows?: number | undefined },
): ParseFileDecision<Record<string, unknown>> {
  const base = { format: parsed.format, filename: options.filename };
  switch (parsed.format) {
    case "csv":
      return { ok: true, value: { ...base, ...limitTable(parsed, options.max_rows) } };
    case "xlsx":
      return {
        ok: true,
        value: {
          ...base,
          sheet: parsed.sheet,
          sheets: parsed.sheets,
          ...limitTable(parsed, options.max_rows),
        },
      };
    case "pdf":
      return { ok: true, value: { ...base, text: parsed.text, pages: parsed.pages } };
    case "docx":
      return { ok: true, value: { ...base, text: parsed.markdown } };
    case "zip":
      return {
        ok: true,
        value: { ...base, text: parsed.text, entries: parsed.entries, skipped: parsed.skipped },
      };
  }
}
