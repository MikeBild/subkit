export {
  type ColumnFit,
  type ColumnOption,
  type CreatedBy,
  categoryCounts,
  columnFits,
  columnMask,
  hideableColumns,
  listCategory,
  nextSort,
  type SortOrder,
  type SortValue,
  sortRows,
  sortValueOf,
  toggleColumn,
} from "@/lib/list-state";

import type { CreatedBy } from "@/lib/list-state";

export function createdByMatches(source: unknown, createdBy: CreatedBy): boolean {
  if (createdBy === "all") return true;
  return createdBy === "ai" ? source === "llm" : source !== "llm";
}

export function dayGroup(iso: string, localeTag: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(localeTag, { dateStyle: "medium" }).format(date);
}

export type ListScreen = "inbox" | "sources" | "skills" | "files" | "connectors";

const SORT_ALIASES: Record<ListScreen, Record<string, string>> = {
  inbox: { captured_at: "created" },
  sources: { updated_at: "ingested" },
  skills: { title: "name", updated_at: "changed" },
  files: { filename: "name", created_at: "uploaded" },
  connectors: { display_name: "name", updated_at: "tested", last_tested_at: "tested" },
};
const GROUP_ALIASES: Record<string, string> = { state: "status", health: "status" };

export function legacySearch(search: string, screen: ListScreen): string | null {
  const params = new URLSearchParams(search);
  let changed = false;
  if (params.get("view") === "details") {
    params.delete("view");
    changed = true;
  }
  const group = params.get("group");
  const nextGroup = group ? GROUP_ALIASES[group] : undefined;
  if (nextGroup) {
    params.set("group", nextGroup);
    changed = true;
  }
  const sort = params.get("sort");
  const nextSort = sort ? SORT_ALIASES[screen][sort] : undefined;
  if (nextSort) {
    params.set("sort", nextSort);
    changed = true;
  }
  if (!changed) return null;
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function withCategory(counts: [string, number][], category: string): [string, number][] {
  if (category === "all" || counts.some(([c]) => c === category)) return counts;
  return [...counts, [category, 0]];
}
