// Ground-truth list contract for every tenant-scoped list service.
//
// Root cause (sessions 2026-06-11/12): no list path returned the true
// total, so every consumer — fast path, conversation tool, LLM, sk
// renderer — could only present a page as if it were the universe. Any
// fixed cap reproduces the lie at a different scale. The fix lives at
// the service layer: every list function returns `{ rows, total }`
// where `total` is the tenant-scoped count under the SAME WHERE
// filters (minus limit/offset), computed via `count(*) over ()` in the
// same query — no second round trip on the populated path.

import { sql } from "drizzle-orm";

export interface ListResult<T> {
  /** The page of rows (bounded by limit/offset). */
  rows: T[];
  /** Exact row count matching the query's filters, ignoring limit/offset. */
  total: number;
}

/**
 * Window-function total selector. Add as a projected column next to the
 * row payload:
 *
 *   db.select({ row: workflows, total: totalOverWindow() })
 *
 * Every returned row carries the same total; read it off the first row.
 */
export function totalOverWindow() {
  return sql<number>`count(*) over ()::int`;
}

/**
 * Resolve the exact total from a window-counted page. When the page is
 * empty the window function returned no rows: with `offset === 0` that
 * means the filtered set is empty (total 0); with a positive offset the
 * caller paged past the end and must fall back to the provided count
 * query (the only case that costs a second round trip — by construction
 * it cannot happen on the common path).
 */
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
