import type { ReactNode } from "react";

export interface TableSelection<TData> {
  selected: ReadonlySet<string>;
  onChange(next: ReadonlySet<string>): void;
  canSelect?(row: TData): boolean;
  rowLabel(row: TData): string;
  allLabel: string;
  bar?: ReactNode;
}

export type SelectionState = "none" | "some" | "all";

export function selectionState(
  selectable: readonly string[],
  selected: ReadonlySet<string>,
): SelectionState {
  const chosen = selectable.filter((id) => selected.has(id)).length;
  if (chosen === 0) return "none";
  return chosen === selectable.length ? "all" : "some";
}

export function toggleAllSelected(
  selectable: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (selectionState(selectable, selected) === "all") for (const id of selectable) next.delete(id);
  else for (const id of selectable) next.add(id);
  return next;
}

export function toggleSelected(
  id: string,
  selected: ReadonlySet<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

export function keepSelectable(
  selectable: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const allowed = new Set(selectable);
  return new Set([...selected].filter((id) => allowed.has(id)));
}
