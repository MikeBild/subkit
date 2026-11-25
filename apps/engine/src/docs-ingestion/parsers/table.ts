import { type CsvRowError, parseCsvRows } from "./csv.ts";
import type { TableParseOptions } from "./table-options.ts";
import { parseXlsxTable } from "./xlsx.ts";

export type TableFormat = TableParseOptions["format"];

interface TableMeta {
  row_count: number;
  truncated: boolean;
  sheet?: string;
  sheets?: string[];
}

type TableFailure =
  | { ok: false; reason: "malformed"; message: string; errors: CsvRowError[] }
  | { ok: false; reason: "sheet_missing"; sheets: string[] };

export type TableResult =
  | ({ ok: true; format: TableFormat; rows: Array<Record<string, unknown>> } & TableMeta)
  | TableFailure;

export type PackedTable =
  | ({ ok: true; format: TableFormat; fields: string[]; rows_json: string } & TableMeta)
  | TableFailure;

export function parseTable(buffer: Buffer, options: TableParseOptions): TableResult {
  if (options.format === "csv") {
    const csv = parseCsvRows(buffer, options);
    if (!csv.ok)
      return { ok: false, reason: "malformed", message: csv.message, errors: csv.errors };
    return {
      ok: true,
      format: "csv",
      rows: csv.rows,
      row_count: csv.row_count,
      truncated: csv.truncated,
    };
  }
  const xlsx = parseXlsxTable(buffer, { sheet: options.sheet, max_rows: options.max_rows });
  if (!xlsx.ok) return { ok: false, reason: "sheet_missing", sheets: xlsx.sheets };
  const { ok: _ok, ...table } = xlsx;
  return { ok: true, format: "xlsx", ...table };
}

export function packTable(result: TableResult): PackedTable {
  if (!result.ok) return result;
  const { rows, ...meta } = result;
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const values = rows.map((row) => fields.map((field) => (field in row ? row[field] : null)));
  return { ...meta, fields, rows_json: JSON.stringify(values) };
}

export function unpackTable(packed: PackedTable): TableResult {
  if (!packed.ok) return packed;
  const { fields, rows_json, ...meta } = packed;
  const values = JSON.parse(rows_json) as unknown[][];
  const rows = values.map((row) =>
    Object.fromEntries(fields.map((field, index) => [field, row[index] ?? null])),
  );
  return { ...meta, rows };
}
