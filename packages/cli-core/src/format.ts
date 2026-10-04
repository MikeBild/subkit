export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${toJson(value)}\n`);
}

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

export interface CategoryBlockSummary {
  category: string;
  count: number;
}

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
