import Papa from "papaparse";

const MAX_REPORTED_ERRORS = 5;

export interface CsvRowError {
  code: string;
  row: number;
  message: string;
}

export type CsvRowsResult =
  | { ok: true; rows: Record<string, string>[]; row_count: number; truncated: boolean }
  | { ok: false; message: string; errors: CsvRowError[] };

export function parseCsvRows(bytes: Uint8Array, options: { max_rows: number }): CsvRowsResult {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const rows: Record<string, string>[] = [];
  const errors: CsvRowError[] = [];
  let rowCount = 0;
  Papa.parse<Record<string, string>>(text, {
    header: true,
    delimiter: ",",
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

export type PackedCsvRows =
  | { ok: true; fields: string[]; rows_json: string; row_count: number; truncated: boolean }
  | { ok: false; message: string; errors: CsvRowError[] };

export function packCsvRows(result: CsvRowsResult): PackedCsvRows {
  if (!result.ok) return result;
  const fields = Object.keys(result.rows[0] ?? {});
  return {
    ok: true,
    fields,
    rows_json: JSON.stringify(result.rows.map((row) => fields.map((field) => row[field] ?? ""))),
    row_count: result.row_count,
    truncated: result.truncated,
  };
}

export function unpackCsvRows(packed: PackedCsvRows): CsvRowsResult {
  if (!packed.ok) return packed;
  const values = JSON.parse(packed.rows_json) as string[][];
  return {
    ok: true,
    rows: values.map((row) =>
      Object.fromEntries(packed.fields.map((field, i) => [field, row[i] ?? ""])),
    ),
    row_count: packed.row_count,
    truncated: packed.truncated,
  };
}
