export type BenchmarkProfileName = "smoke" | "release" | "full";

export type BenchmarkLoad = {
  mode: "closed" | "open";
  offered_rate_per_second?: number;
  max_outstanding: number;
};

export type BenchmarkProfile = {
  name: BenchmarkProfileName;
  warmup_ms: number;
  measure_ms: number;
  repeats: number;
  concurrency: number[];
  cases?: string[];
  load: BenchmarkLoad;
};

export type BenchmarkSample = {
  duration_ms: number;
  ok: boolean;
  outcome?: "ok" | "error" | "timeout" | "rejected";
  intended_at_ms?: number;
  error?: string;
};

export type BenchmarkCounts = {
  count: number;
  ok_count: number;
  error_count: number;
  timeout_count: number;
  rejected_count: number;
};

export type BenchmarkCase = {
  name: string;
  family: "javascript" | "jsonata" | "helpers" | "fault";
  size: "small" | "typical" | "large" | "fault";
};

export type BenchmarkRun = {
  case: BenchmarkCase;
  repeat: number;
  concurrency: number;
  warmup_ms: number;
  measure_ms: number;
  measurement_elapsed_ms: number;
  load: BenchmarkLoad;
  samples: BenchmarkSample[];
  totals?: BenchmarkCounts;
  process_memory: { before_rss_bytes: number; after_rss_bytes: number; peak_rss_bytes: number };
};

export type BenchmarkManifest = {
  schema: "subkit-runtime-benchmark";
  label: string;
  profile: BenchmarkProfile;
  started_at: string;
  finished_at: string;
  host: {
    platform: string;
    arch: string;
    bun: string;
    cpu_count: number;
    memory_bytes: number;
    reference_environment: boolean;
    reference_gap?: string;
  };
  source_root: string;
  source_sha256: string;
  lockfile_sha256: string;
  runs: BenchmarkRun[];
  correctness: Array<{ name: string; ok: boolean; detail?: string }>;
};

export type Summary = {
  count: number;
  sampled_count: number;
  ok_count: number;
  error_count: number;
  timeout_count: number;
  rejected_count: number;
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  percentile_label: "sufficient" | "insufficient";
  throughput_per_second?: number;
};
