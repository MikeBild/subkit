import { sql } from "drizzle-orm";

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export function totalOverWindow() {
  return sql<number>`count(*) over ()::int`;
}

export async function resolveWindowTotal(
  rows: ReadonlyArray<{ total: number }>,
  offset: number,
  countBeyondEnd: () => Promise<number>,
): Promise<number> {
  const first = rows[0];
  if (first) return Number(first.total);
  if (offset > 0) return countBeyondEnd();
  return 0;
}
