// Output helpers: JSON emit, simple column table, key/value dump.
//
// Commands pipe these through `process.stdout.write` so stdin/stdout
// are easy to stub in tests.

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${toJson(value)}\n`);
}

/**
 * Render a list of records as a tab-separated table, preserving the
 * caller-provided column order. Unknown keys become empty cells.
 */
export function renderTable(columns: readonly string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const header = columns.join("\t");
  const body = rows
    .map((row) => columns.map((col) => stringifyCell(row[col])).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
}

export function printTable(columns: readonly string[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write("(no rows)\n");
    return;
  }
  process.stdout.write(`${renderTable(columns, rows)}\n`);
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function printKeyValue(record: Record<string, unknown>): void {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    process.stdout.write("(empty)\n");
    return;
  }
  const width = Math.max(...keys.map((k) => k.length));
  for (const k of keys) {
    const v = stringifyCell(record[k]);
    process.stdout.write(`${k.padEnd(width)}  ${v}\n`);
  }
}

/** Pick between table and JSON output based on an asJson flag. */
export function emitList<T extends Record<string, unknown>>(
  asJson: boolean,
  columns: readonly string[],
  rows: T[],
): void {
  if (asJson) {
    printJson(rows);
    return;
  }
  printTable(columns, rows);
}

export function emitOne(asJson: boolean, value: Record<string, unknown>): void {
  if (asJson) {
    printJson(value);
    return;
  }
  printKeyValue(value);
}
