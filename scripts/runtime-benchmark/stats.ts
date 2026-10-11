import type { BenchmarkCounts, BenchmarkSample, Summary } from "./model.ts";

function quantile(sorted: number[], percentile: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index];
}

export function summarize(
  samples: BenchmarkSample[],
  measurementMs?: number,
  totals?: BenchmarkCounts,
): Summary {
  const valid = samples
    .filter((sample) => sample.ok)
    .map((sample) => sample.duration_ms)
    .sort((a, b) => a - b);
  const timeoutCount =
    totals?.timeout_count ?? samples.filter((sample) => sample.outcome === "timeout").length;
  const rejectedCount =
    totals?.rejected_count ?? samples.filter((sample) => sample.outcome === "rejected").length;
  const sampledErrors = samples.filter(
    (sample) => !sample.ok && sample.outcome !== "timeout" && sample.outcome !== "rejected",
  ).length;
  const errors = totals?.error_count ?? sampledErrors;
  const okCount = totals?.ok_count ?? valid.length;
  return {
    count: totals?.count ?? samples.length,
    sampled_count: samples.length,
    ok_count: okCount,
    error_count: errors,
    timeout_count: timeoutCount,
    rejected_count: rejectedCount,
    p50_ms: quantile(valid, 0.5),
    p95_ms: quantile(valid, 0.95),
    p99_ms: quantile(valid, 0.99),
    percentile_label: valid.length >= 10_000 ? "sufficient" : "insufficient",
    throughput_per_second:
      measurementMs && measurementMs > 0 ? okCount / (measurementMs / 1_000) : undefined,
  };
}

export function compareThreshold(
  baseline: Summary,
  candidate: Summary,
): {
  status: "pass" | "fail" | "inconclusive" | "not_comparable";
  limit_ms?: number;
  minimum_throughput_per_second?: number;
} {
  if (baseline.count === 0) return { status: "not_comparable" };
  if (!baseline.p95_ms || !candidate.p95_ms || baseline.error_count || candidate.error_count) {
    return { status: "inconclusive" };
  }
  const limit_ms = Math.max(baseline.p95_ms * 1.15, baseline.p95_ms + 5);
  const minimum_throughput_per_second = baseline.throughput_per_second
    ? baseline.throughput_per_second * 0.9
    : undefined;
  const latencyPasses = candidate.p95_ms <= limit_ms;
  const throughputPasses =
    minimum_throughput_per_second === undefined ||
    (candidate.throughput_per_second ?? 0) >= minimum_throughput_per_second;
  return {
    status: latencyPasses && throughputPasses ? "pass" : "fail",
    limit_ms,
    ...(minimum_throughput_per_second === undefined ? {} : { minimum_throughput_per_second }),
  };
}

export function compareReleaseCapacity(
  candidate: Summary,
  requireThroughput = true,
): {
  status: "pass" | "fail" | "inconclusive";
  maximum_p95_ms: number;
  minimum_throughput_per_second?: number;
} {
  const maximum_p95_ms = 100;
  const minimum_throughput_per_second = 100;
  const threshold = {
    maximum_p95_ms,
    ...(requireThroughput ? { minimum_throughput_per_second } : {}),
  };
  if (
    candidate.p95_ms === undefined ||
    (requireThroughput && candidate.throughput_per_second === undefined) ||
    candidate.percentile_label === "insufficient"
  ) {
    return { status: "inconclusive", ...threshold };
  }
  return {
    status:
      candidate.p95_ms <= maximum_p95_ms &&
      (!requireThroughput ||
        (candidate.throughput_per_second ?? 0) >= minimum_throughput_per_second) &&
      candidate.error_count === 0 &&
      candidate.timeout_count === 0 &&
      candidate.rejected_count === 0
        ? "pass"
        : "fail",
    ...threshold,
  };
}
