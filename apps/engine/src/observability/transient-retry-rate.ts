import { errorFields, logger } from "../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

let _lastTransientTotal = 0;
let _lastTransientSampleAtMs: number | null = null;
export function sampleTransientRetryRate(opts?: { nowMs?: number }): void {
  try {
    const now = opts?.nowMs ?? Date.now();
    const total = getMetrics().counterSum(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    if (_lastTransientSampleAtMs !== null) {
      const deltaMin = (now - _lastTransientSampleAtMs) / 60_000;
      if (deltaMin > 0) {
        const rate = Math.max(0, total - _lastTransientTotal) / deltaMin;
        getMetrics().set(METRIC_NAMES.DB_TRANSIENT_RETRY_RATE_PER_MIN, rate, {});
      }
    }
    _lastTransientTotal = total;
    _lastTransientSampleAtMs = now;
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "metrics.write_failed",
      msg: "transient-retry-rate sample threw — ignoring",
      ...errorFields(err),
    });
  }
}

export function _resetTransientRetryRateForTests(): void {
  _lastTransientTotal = 0;
  _lastTransientSampleAtMs = null;
}
