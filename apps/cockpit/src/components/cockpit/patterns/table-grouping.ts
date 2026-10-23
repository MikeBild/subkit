import type { ReactNode } from "react";
import type { ListReturnStore } from "./list-return";

export interface TableGrouping<T> {
  getKey(row: T): string;
  label?(key: string): string;
  compareKeys?(left: string, right: string): number;
  count?(key: string): number | undefined;
  badge?(key: string, rows: readonly T[]): ReactNode;
  rankWithin?(row: T): number;
  collapseScope?: string;
}

export function orderGroupedRows<T>(rows: readonly T[], grouping: TableGrouping<T>): T[] {
  const keyed = rows.map((row, position) => ({
    row,
    position,
    key: grouping.getKey(row),
    rank: grouping.rankWithin?.(row) ?? 0,
  }));
  keyed.sort(
    (left, right) =>
      (grouping.compareKeys?.(left.key, right.key) ?? left.key.localeCompare(right.key)) ||
      left.rank - right.rank ||
      left.position - right.position,
  );
  return keyed.map((entry) => entry.row);
}

export function rowsByGroup<T>(rows: readonly T[], getKey: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = getKey(row);
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function collapsedKey(scope: string): string {
  return `sk.list-groups:${scope}`;
}

function sessionStore(): ListReturnStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readCollapsedGroups(
  scope: string,
  store: ListReturnStore | null = sessionStore(),
): ReadonlySet<string> {
  if (!store) return new Set();
  try {
    const parsed: unknown = JSON.parse(store.getItem(collapsedKey(scope)) ?? "[]");
    return new Set(
      Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(
  scope: string,
  keys: ReadonlySet<string>,
  store: ListReturnStore | null = sessionStore(),
): void {
  if (!store) return;
  try {
    if (keys.size === 0) store.removeItem(collapsedKey(scope));
    else store.setItem(collapsedKey(scope), JSON.stringify([...keys]));
  } catch {}
}

export function toggleGroup(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
