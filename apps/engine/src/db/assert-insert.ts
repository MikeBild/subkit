export function assertInsertRow<T>(row: T | undefined, table: string): asserts row is T {
  if (!row) throw new Error(`${table} insert returned no row`);
}
