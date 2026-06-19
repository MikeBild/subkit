// Observability primitives shared by the metrics registry, instrumentation
// helpers, and the /metrics route.
//
// The collector is hand-rolled — no `prom-client` (or any other metrics
// dependency) is allowed. Three series kinds are supported:
//
//   - Counter: monotonically-increasing integer; bumped via `inc()`.
//   - Gauge:   point-in-time value; set via `set()`.
//   - Histogram: counts observations into a fixed bucket ladder + tracks
//     sum + count for percentile estimation.
//
// All series carry a flat label set. The set of legal label keys is
// declared up front and enforced at write time so we never grow an
// unbounded cardinality cardinal cluster of label combinations.

export type LabelValues = Record<string, string | number>;

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name: string;
  help: string;
  kind: MetricKind;
  /**
   * Allow-listed label keys for this series. Any key passed at write
   * time that is not in this list is dropped (and a one-shot warning
   * is logged) so a typo can't blow up cardinality.
   */
  labels: readonly string[];
  /**
   * Histogram bucket upper bounds in ms. Required when kind === "histogram".
   * The `+Inf` bucket is implied and need not be passed.
   */
  buckets?: readonly number[];
}

export interface SeriesSnapshot {
  name: string;
  help: string;
  kind: MetricKind;
  samples: SampleSnapshot[];
}

export interface SampleSnapshot {
  /**
   * For counters and gauges this is `<name>` plus the optional `_bucket`
   * / `_sum` / `_count` suffix used by histograms.
   */
  name: string;
  labels: Record<string, string>;
  value: number;
}
