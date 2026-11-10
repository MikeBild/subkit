export type BaselineMeasurement = Readonly<{ test: string; durationMs: number }>;

export function deriveDistributedBaselineBudget(
  tests: readonly string[],
  measurements: readonly BaselineMeasurement[],
): Readonly<{
  baseline_budget_ms: number;
  measured_ms: number;
  measured_files: number;
  guarded_files: number;
}> {
  if (tests.length === 0 || new Set(tests).size !== tests.length)
    throw new Error("Baseline scope must be nonempty and unique");
  const durations = new Map<string, number>();
  for (const measurement of measurements) {
    if (
      durations.has(measurement.test) ||
      !Number.isSafeInteger(measurement.durationMs) ||
      measurement.durationMs < 0
    )
      throw new Error("Invalid or duplicate baseline measurement");
    durations.set(measurement.test, measurement.durationMs);
  }
  let measuredMs = 0;
  let measuredFiles = 0;
  for (const test of tests) {
    const duration = durations.get(test);
    if (duration !== undefined) {
      measuredMs += duration;
      measuredFiles += 1;
    }
  }
  const guardedFiles = tests.length - measuredFiles;
  const baselineBudgetMs = Math.ceil(measuredMs * 1.5 + guardedFiles * 155_000 + 60_000);
  if (!Number.isSafeInteger(baselineBudgetMs))
    throw new Error("Baseline budget exceeds numeric bounds");
  return {
    baseline_budget_ms: baselineBudgetMs,
    measured_ms: measuredMs,
    measured_files: measuredFiles,
    guarded_files: guardedFiles,
  };
}
