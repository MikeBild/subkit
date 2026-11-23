import type { EntryView } from "./knowledge";

export type BulkAction = "move" | "discard" | "propose" | "remove";

export const BULK_PROPOSE_LIMIT = 100;

const OPEN_STATES: ReadonlySet<EntryView["state"]> = new Set(["collected", "reviewing"]);

export function isSelectable(entry: Pick<EntryView, "state">): boolean {
  return entry.state !== "admitted";
}

export function bulkActions(selected: readonly Pick<EntryView, "state">[]): BulkAction[] {
  if (selected.length === 0) return [];
  if (selected.every((e) => e.state === "discarded")) return ["remove"];
  if (!selected.every((e) => OPEN_STATES.has(e.state))) return [];
  return selected.length <= BULK_PROPOSE_LIMIT
    ? ["move", "discard", "propose"]
    : ["move", "discard"];
}

export function entryGroupKey(item: unknown): string | null {
  const raw = (item as { group_key?: unknown } | null)?.group_key;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

export function groupLabel(key: string | null, other: string): string {
  if (!key) return other;
  const at = key.indexOf(":");
  const kind = at === -1 ? "" : key.slice(0, at);
  const value = at === -1 ? key : key.slice(at + 1);
  if (!value) return other;
  return kind === "tag" ? `#${value}` : value;
}

export interface BulkOutcome {
  done: number;
  conflicts: number;
}

export async function runBulk<T>(
  list: readonly T[],
  apply: (item: T) => Promise<unknown>,
  isConflict: (error: unknown) => boolean,
): Promise<BulkOutcome> {
  let done = 0;
  let conflicts = 0;
  for (const item of list) {
    try {
      await apply(item);
      done += 1;
    } catch (error) {
      if (!isConflict(error)) throw error;
      conflicts += 1;
    }
  }
  return { done, conflicts };
}
