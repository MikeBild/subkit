export type LabelValues = Record<string, string | number>;

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  name: string;
  help: string;
  kind: MetricKind;
  labels: readonly string[];
  buckets?: readonly number[];
}

export interface SeriesSnapshot {
  name: string;
  help: string;
  kind: MetricKind;
  samples: SampleSnapshot[];
}

export interface SampleSnapshot {
  name: string;
  labels: Record<string, string>;
  value: number;
}
