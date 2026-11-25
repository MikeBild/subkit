export type SortOrder = "asc" | "desc";
export type CreatedBy = "all" | "ai" | "person";
export type SortValue = string | number | null | undefined;

export function sortValueOf<T>(
  table: Readonly<Record<string, (row: T) => SortValue>>,
  key: string,
): ((row: T) => SortValue) | null {
  return Object.entries(table).find(([name]) => name === key)?.[1] ?? null;
}

export function sortRows<T>(
  rows: readonly T[],
  value: ((row: T) => SortValue) | null,
  order: SortOrder,
): T[] {
  if (!value) return [...rows];
  const sign = order === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      if (a.key == null && b.key == null) return a.index - b.index;
      if (a.key == null) return 1;
      if (b.key == null) return -1;
      const diff =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key), undefined, { sensitivity: "base" });
      return diff === 0 ? a.index - b.index : diff * sign;
    })
    .map(({ row }) => row);
}

export function nextSort(
  current: { key: string; order: SortOrder },
  key: string,
): { key: string; order: SortOrder } {
  if (current.key !== key) return { key, order: "asc" };
  if (current.order === "asc") return { key, order: "desc" };
  return { key: "", order: "asc" };
}

export function categoryCounts(items: readonly { category: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const { category } of items)
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function listCategory(raw: string, fallback: string | undefined): string {
  return raw || fallback || "all";
}

export interface ColumnOption {
  id: string;
  label: string;
  priority?: "low";
}

export type ColumnFit = "control" | "name" | "fit" | "low";

function fixedColumn(columns: readonly ColumnOption[]): string | undefined {
  return columns.find((c) => c.label !== "")?.id;
}

export function columnFits(columns: readonly ColumnOption[]): ColumnFit[] {
  const fixed = fixedColumn(columns);
  return columns.map((c) =>
    c.label === "" ? "control" : c.id === fixed ? "name" : c.priority === "low" ? "low" : "fit",
  );
}

export function hideableColumns(columns: readonly ColumnOption[]): ColumnOption[] {
  const fixed = fixedColumn(columns);
  return columns.filter((c) => c.label !== "" && c.id !== fixed);
}

export function toggleColumn(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function columnMask(
  columns: readonly ColumnOption[],
  hidden: ReadonlySet<string>,
): boolean[] {
  const off = new Set(
    hideableColumns(columns)
      .filter((c) => hidden.has(c.id))
      .map((c) => c.id),
  );
  return columns.map((c) => !off.has(c.id));
}
