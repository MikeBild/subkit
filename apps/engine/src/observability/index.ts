// Hand-rolled, no-prom-client metrics surface for the subkit engine.
//
// Naming conventions (Prometheus):
//
//   - Counters end in `_total` (`execution_total`, `request_retry_total`).
//   - Gauges have no suffix and represent a point-in-time value
//     (`queue_depth`, `tunnel_connected`).
//   - Histograms expose `_bucket{le=...}`, `_sum`, and `_count` series;
//     the base name carries the unit suffix (`execution_duration_ms`).
//
// Why hand-rolled? The series we expose are small, bounded, and stable.
// Pulling in `prom-client` (or any equivalent) would add a runtime
// dependency for ~120 lines of arithmetic. The collector enforces a
// declared label allow-list per metric so a typo at a call site can
// never blow up cardinality.
//
// The canonical registry is process-scoped via `getMetrics()`. Tests
// can use `resetMetricsRegistryForTests()` to start from a clean slate.

export {
  recordChatDelivery,
  recordExecutionTerminal,
  recordLlmQuotaExhausted,
  recordLlmTokens,
  recordPatchCandidate,
  recordRequestRetry,
  recordWebhookDelivery,
  setOutboxCursorLag,
  setQueueDepth,
  setQueueLag,
  setTunnelConnected,
} from "./instrumentation.ts";
export {
  getMetrics,
  METRIC_NAMES,
  MetricsRegistry,
  refreshProcessUptime,
  resetMetricsRegistryForTests,
} from "./metrics.ts";
export { metricsMiddleware } from "./middleware.ts";
export type { LabelValues, MetricDefinition, SampleSnapshot, SeriesSnapshot } from "./types.ts";
