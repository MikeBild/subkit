export function matches(q: string, ...texts: string[]) {
  const n = q.trim().toLocaleLowerCase();
  return !n || texts.some((t) => t.toLocaleLowerCase().includes(n));
}

export function groupBy<T>(items: T[], key: ((x: T) => string) | null): [string, T[]][] {
  if (!key) return [["", items]];
  const m = new Map<string, T[]>();
  for (const it of items) {
    const g = key(it);
    m.set(g, [...(m.get(g) ?? []), it]);
  }
  return [...m.entries()];
}
