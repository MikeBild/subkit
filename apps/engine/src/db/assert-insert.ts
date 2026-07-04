// Single-row insert assertion. Replaces the hand-rolled
// `if (!row) throw new Error("X insert returned no row")` patterns.
//
// Drizzle's `.returning()` returns `T[]`. Most call sites destructure
// `[row] = await db.insert(...).values(...).returning()` and want a guaranteed
// non-null row; this helper makes the assertion uniform and single-sourced.
//
// Uses `asserts` so callers don't need to capture a return value — after the
// call, TypeScript narrows `row` from `T | undefined` to `T`.

export function assertInsertRow<T>(row: T | undefined, table: string): asserts row is T {
  if (!row) throw new Error(`${table} insert returned no row`);
}
