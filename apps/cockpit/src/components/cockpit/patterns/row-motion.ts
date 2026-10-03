import { useEffect, useRef, useState } from "react";

// How a list's rows change between two renders, so a live update can show
// itself: a row that arrived washes in with the accent, a row that went fades
// out where it stood. Neither happens on the first rows, on a page of older
// rows appended at the end, or when a search or a filter replaced the list —
// those are the reader's own doing and need no announcement.

export interface RowChange<T> {
  /** Ids that appeared among the rows already shown. */
  arrived: ReadonlySet<string>;
  /** Rows that went, with the place they stood. */
  left: readonly { id: string; index: number; row: T }[];
}

const NONE: RowChange<never> = { arrived: new Set(), left: [] };

/**
 * The change from `previous` to `next`. A list where fewer than half of the
 * rows shown before are still there was replaced, not updated.
 */
export function rowChange<T>(
  previous: readonly { id: string; row: T }[] | null,
  next: readonly { id: string; row: T }[],
): RowChange<T> {
  if (!previous || previous.length === 0) return NONE;
  const nextIds = new Set(next.map((entry) => entry.id));
  const kept = previous.filter((entry) => nextIds.has(entry.id)).length;
  if (kept * 2 < previous.length) return NONE;
  const before = new Set(previous.map((entry) => entry.id));
  // The last row that was already shown: anything new after it is a page of
  // older rows, appended — not an arrival.
  let lastKnown = -1;
  next.forEach((entry, index) => {
    if (before.has(entry.id)) lastKnown = index;
  });
  const arrived = new Set(
    next.filter((entry, index) => !before.has(entry.id) && index < lastKnown).map((e) => e.id),
  );
  const left = previous
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => !nextIds.has(entry.id));
  return { arrived, left };
}

/** `rows` with the rows that just left put back where they stood, for their fade. */
export function withLeaving<T>(
  rows: readonly T[],
  leaving: readonly { index: number; row: T }[],
): { row: T; leaving: boolean }[] {
  const out = rows.map((row) => ({ row, leaving: false }));
  for (const entry of [...leaving].sort((a, b) => a.index - b.index))
    out.splice(Math.min(entry.index, out.length), 0, { row: entry.row, leaving: true });
  return out;
}

/** How long a leaving row stays for its fade (the base duration). */
export const LEAVE_MS = 180;
/** How long an arrived row keeps its accent class (the arrival wash). */
export const ARRIVAL_MS = 1_200;

/**
 * The row motion of one list. Without `getRowId` rows have no identity
 * across renders, and nothing moves.
 */
export function useRowMotion<T>(
  rows: readonly T[],
  getRowId: ((row: T) => string) | undefined,
  ready: boolean,
): { arrived: ReadonlySet<string>; display: { row: T; leaving: boolean }[] } {
  const previous = useRef<{ id: string; row: T }[] | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState<readonly { id: string; index: number; row: T }[]>([]);

  const timers = useRef<{
    arrived?: ReturnType<typeof setTimeout>;
    leaving?: ReturnType<typeof setTimeout>;
  }>({});

  useEffect(() => {
    if (!getRowId || !ready) return;
    const next = rows.map((row) => ({ id: getRowId(row), row }));
    const change = rowChange(previous.current, next);
    previous.current = next;
    if (change.arrived.size > 0) {
      clearTimeout(timers.current.arrived);
      setArrived(change.arrived);
      timers.current.arrived = setTimeout(() => setArrived(new Set()), ARRIVAL_MS);
    }
    if (change.left.length > 0) {
      clearTimeout(timers.current.leaving);
      setLeaving(change.left);
      timers.current.leaving = setTimeout(() => setLeaving([]), LEAVE_MS);
    }
  }, [rows, getRowId, ready]);

  useEffect(
    () => () => {
      clearTimeout(timers.current.arrived);
      clearTimeout(timers.current.leaving);
    },
    [],
  );

  if (!getRowId) return { arrived, display: rows.map((row) => ({ row, leaving: false })) };
  const present = new Set(rows.map(getRowId));
  return {
    arrived,
    display: withLeaving(
      rows,
      leaving.filter((entry) => !present.has(entry.id)),
    ),
  };
}
