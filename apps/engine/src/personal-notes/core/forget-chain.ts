export interface ChainLink {
  readonly id: string;
  readonly replaced_by: string | null;
}

export function forgetChain(rows: readonly ChainLink[], id: string): string[] {
  if (!rows.some((row) => row.id === id)) return [];
  const earlier = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.replaced_by) continue;
    const list = earlier.get(row.replaced_by) ?? [];
    list.push(row.id);
    earlier.set(row.replaced_by, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    for (const previous of earlier.get(current) ?? []) queue.push(previous);
  }
  return out;
}

export function earlierVersions<T extends ChainLink>(rows: readonly T[], id: string): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return forgetChain(rows, id)
    .slice(1)
    .map((link) => byId.get(link) as T);
}
