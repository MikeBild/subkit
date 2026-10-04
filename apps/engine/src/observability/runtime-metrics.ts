import { METRIC_NAMES, type MetricsRegistry } from "./metrics.ts";

const DURATION_BUCKETS_MS = [10, 50, 250, 1000, 5000, 30000, 300000, 3600000] as const;

export function registerRuntimeTelemetryMetrics(reg: MetricsRegistry): void {
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_MEMORY_RSS_BYTES,
    help: "Resident set size of the engine process in bytes (sampled).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_MEMORY_HEAP_USED_BYTES,
    help: "V8/JSC heap bytes in use by the engine process (sampled).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_MEMORY_HEAP_TOTAL_BYTES,
    help: "V8/JSC heap bytes reserved by the engine process (sampled).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_MEMORY_EXTERNAL_BYTES,
    help: "Off-heap (external) bytes held by the engine process (sampled).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.EVENT_LOOP_LAG_MS,
    help: "Event-loop lag in milliseconds (sampled timer drift).",
    labels: [],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.BOOT_PHASE_DURATION_MS,
    help: "Duration of each engine boot phase in milliseconds.",
    labels: ["phase"],
    buckets: DURATION_BUCKETS_MS,
  });
  reg.registerHistogram({
    name: METRIC_NAMES.OPERATION_DURATION_MS,
    help: "Duration of operations wrapped by instrument() in milliseconds.",
    labels: ["module", "action", "outcome"],
    buckets: DURATION_BUCKETS_MS,
  });
}
