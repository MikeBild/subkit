import { type AnyColumn, asc, type SQL, sql } from "drizzle-orm";
import { type CatalogGroupBy, UNCATEGORIZED } from "../api/catalog-metadata.ts";

export interface ListResult<T> {
  rows: T[];
  total: number;
}

export function totalOverWindow() {
  return sql<number>`count(*) over ()::int`;
}

export function catalogGroupOrder(groupBy: CatalogGroupBy | undefined, category: AnyColumn): SQL[] {
  return groupBy === "category" ? [sql`(${category} = ${UNCATEGORIZED}) asc`, asc(category)] : [];
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
