import Papa from "papaparse";

const MAX_REPORTED_ERRORS = 5;
const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
const DELIMITER_SAMPLE_CHARS = 65_536;
const DELIMITER_SAMPLE_LINES = 10;

export interface CsvRowError {
  code: string;
  row: number;
  message: string;
}

export type CsvRowsResult =
  | { ok: true; rows: Record<string, string>[]; row_count: number; truncated: boolean }
  | { ok: false; message: string; errors: CsvRowError[] };

export function decodeCsvText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.replace(/^\uFEFF/, "");
}

export function detectCsvDelimiter(text: string): string {
  const head = text.slice(0, DELIMITER_SAMPLE_CHARS);
  const lastBreak = head.lastIndexOf("\n");
  const sample = text.length > head.length && lastBreak > 0 ? head.slice(0, lastBreak) : head;
  let best = ",";
  let bestFields = 1;
  for (const delimiter of CSV_DELIMITERS) {
    const parsed = Papa.parse<string[]>(sample, {
      delimiter,
      preview: DELIMITER_SAMPLE_LINES,
      skipEmptyLines: "greedy",
    });
    const first = parsed.data[0]?.length ?? 0;
    if (first > bestFields && parsed.data.every((row) => row.length === first)) {
      best = delimiter;
      bestFields = first;
    }
  }
  return best;
}

export function parseCsvRows(bytes: Uint8Array, options: { max_rows: number }): CsvRowsResult {
  const text = decodeCsvText(bytes);
  const rows: Record<string, string>[] = [];
  const errors: CsvRowError[] = [];
  let rowCount = 0;
  Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter: detectCsvDelimiter(text),
    skipEmptyLines: "greedy",
    step(result, parser) {
      rowCount += 1;
      for (const error of result.errors) {
        errors.push({ code: error.code, row: rowCount, message: error.message });
      }
      if (errors.length >= MAX_REPORTED_ERRORS) parser.abort();
      if (errors.length === 0 && rows.length < options.max_rows) rows.push(result.data);
    },
  });
  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    const first = shown[0] as CsvRowError;
    return {
      ok: false,
      message: `The CSV file is malformed: ${first.message} (row ${first.row}).`,
      errors: shown,
    };
  }
  return { ok: true, rows, row_count: rowCount, truncated: rowCount > options.max_rows };
}
