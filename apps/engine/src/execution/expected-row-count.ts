// Polymorphic `expected_row_count` evaluator. Supports:
//   - number            exact match
//   - [min, max]        inclusive range tuple
//   - { min, max }      inclusive range object (either bound may be omitted)
//
// Pure function. Returns `null` on satisfied, otherwise a string
// describing the mismatch — caller threads it into the typed
// `expected_row_count_mismatch` envelope.

export type ExpectedRowCount =
  number | readonly [number, number] | [number, number] | { min?: number; max?: number };

export function evaluateExpectedRowCount(
  expected: ExpectedRowCount,
  actual: number,
): string | null {
  if (typeof expected === "number") {
    return actual === expected ? null : `expected exactly ${expected} rows, got ${actual}`;
  }
  if (Array.isArray(expected)) {
    const [lo, hi] = expected as readonly [number, number];
    return actual >= lo && actual <= hi
      ? null
      : `expected row count in [${lo}, ${hi}], got ${actual}`;
  }
  const obj = expected as { min?: number; max?: number };
  const min = obj.min;
  const max = obj.max;
  if (min !== undefined && actual < min) {
    return `expected at least ${min} rows, got ${actual}`;
  }
  if (max !== undefined && actual > max) {
    return `expected at most ${max} rows, got ${actual}`;
  }
  return null;
}
