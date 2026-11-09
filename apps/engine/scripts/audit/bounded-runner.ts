export function boundedConcurrency(value: string | undefined, fallback = 2): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-4]$/.test(value)) {
    throw new Error("SUBKIT_COVERAGE_CONCURRENCY must be an integer from 1 through 4");
  }
  return Number(value);
}

export async function runBoundedInOrder<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  const results = new Array<R>(values.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index] as T, index);
      } catch (error) {
        failed = true;
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failed) throw firstError;
  return results;
}
