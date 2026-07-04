// Windowed transient-DB-retry rate sampler.
//
// Split out of instrumentation.ts to keep that file under the 1000-LOC ceiling
// (same domain-seam pattern as metric-label-allowlists.ts / metrics-registry.ts).
// This is the one *stateful, derived* gauge — it charts the delta of the
// cumulative `db_transient_retries_total` counter over the real elapsed interval
// between sampler ticks, rather than a point read of a raw counter.

import { errorFields, logger } from "../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

/** Windowed transient-DB-retry rate. The first call only establishes the
 *  baseline (gauge stays 0); each later call charts the delta in the cumulative
 *  retry counter over the REAL elapsed interval and writes it to a per-minute
 *  gauge. Driven by the 60s memory sampler. This is what makes the
 *  transient-retry risk signal a leading indicator: a one-off Postgres blip
 *  decays to 0 within a window or two, instead of latching the warn forever the
 *  way `cumulative_total ÷ uptime` (a lifetime average) would. `nowMs` is
 *  injectable so the windowing is deterministic under test. No-throw, like the
 *  rest of the observability surface — a sampler hiccup must never fault the
 *  tick that drives it. */
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

/** Test-only — reset the windowed retry-rate sampler baseline. */
export function _resetTransientRetryRateForTests(): void {
  _lastTransientTotal = 0;
  _lastTransientSampleAtMs = null;
}
