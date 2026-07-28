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

/** One catalog block, as the engine reports it on a list response. */
export interface CategoryBlockSummary {
  category: string;
  count: number;
}

/**
 * Render a catalog as titled blocks instead of one flat table.
 *
 * The block ORDER comes from the server (`categories` on the list response),
 * never from a rule re-implemented here — the engine owns "largest block
 * first, catch-all last" and every client must agree with it. Rows are matched
 * to a block by their own `category` field; anything the server did not
 * announce is appended in a final pass so a row can never be swallowed.
 *
 * JSON output stays FLAT and unchanged: machine consumers keep a stable shape,
 * and the blocks are already present as `category` on each row.
 */
export function emitGroupedList<T extends Record<string, unknown>>(
  asJson: boolean,
  columns: readonly string[],
  rows: T[],
  blocks: readonly CategoryBlockSummary[],
): void {
  if (asJson) {
    printJson(rows);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("(no rows)\n");
    return;
  }
  const rendered = new Set<T>();
  for (const block of blocks) {
    const items = rows.filter((r) => r.category === block.category);
    if (items.length === 0) continue;
    for (const item of items) rendered.add(item);
    process.stdout.write(`\n${block.category}  (${items.length})\n`);
    printTable(columns, items);
  }
  const orphans = rows.filter((r) => !rendered.has(r));
  if (orphans.length > 0) {
    process.stdout.write(`\n(ungrouped)  (${orphans.length})\n`);
    printTable(columns, orphans);
  }
}

export function emitOne(asJson: boolean, value: Record<string, unknown>): void {
  if (asJson) {
    printJson(value);
    return;
  }
  printKeyValue(value);
}
