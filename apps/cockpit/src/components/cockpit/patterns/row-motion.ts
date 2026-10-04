import { useEffect, useRef, useState } from "react";

export interface RowChange<T> {
  arrived: ReadonlySet<string>;
  left: readonly { id: string; index: number; row: T }[];
}

const NONE: RowChange<never> = { arrived: new Set(), left: [] };

export function rowChange<T>(
  previous: readonly { id: string; row: T }[] | null,
  next: readonly { id: string; row: T }[],
): RowChange<T> {
  if (!previous || previous.length === 0) return NONE;
  const nextIds = new Set(next.map((entry) => entry.id));
  const kept = previous.filter((entry) => nextIds.has(entry.id)).length;
  if (kept * 2 < previous.length) return NONE;
  const before = new Set(previous.map((entry) => entry.id));
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

export function withLeaving<T>(
  rows: readonly T[],
  leaving: readonly { index: number; row: T }[],
): { row: T; leaving: boolean }[] {
  const out = rows.map((row) => ({ row, leaving: false }));
  for (const entry of [...leaving].sort((a, b) => a.index - b.index))
    out.splice(Math.min(entry.index, out.length), 0, { row: entry.row, leaving: true });
  return out;
}

export const LEAVE_MS = 180;
export const ARRIVAL_MS = 1_200;

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
