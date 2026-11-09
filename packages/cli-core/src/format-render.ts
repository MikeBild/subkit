export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function renderTable(columns: readonly string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const header = columns.join("\t");
  const body = rows
    .map((row) => columns.map((col) => stringifyCell(row[col])).join("\t"))
    .join("\n");
  return `${header}\n${body}`;
}

export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
