import { logger } from "../logging/logger.ts";
import type { LabelValues, MetricDefinition, SampleSnapshot, SeriesSnapshot } from "./types.ts";

const DROPPED_LABEL_WARNINGS = new Set<string>();

function sortObjectKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key] as string;
  }
  return out;
}

function normalizeLabels(
  metric: MetricDefinition,
  raw: LabelValues | undefined,
): Record<string, string> {
  const allowed = new Set(metric.labels);
  const result: Record<string, string> = {};
  if (!raw) {
    for (const k of metric.labels) result[k] = "";
    return sortObjectKeys(result);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) {
      const warnKey = `${metric.name}::${k}`;
      if (!DROPPED_LABEL_WARNINGS.has(warnKey)) {
        DROPPED_LABEL_WARNINGS.add(warnKey);
        logger.warn({
          module: "observability",
          action: "metrics.label_dropped",
          msg: "metric label dropped (not in allow-list)",
          metric: metric.name,
          label: k,
        });
      }
      continue;
    }
    result[k] = String(v ?? "");
  }
  for (const k of metric.labels) {
    if (!(k in result)) result[k] = "";
  }
  return sortObjectKeys(result);
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

interface CounterSeries {
  def: MetricDefinition;
  values: Map<string, { labels: Record<string, string>; value: number }>;
}

interface GaugeSeries {
  def: MetricDefinition;
  values: Map<string, { labels: Record<string, string>; value: number }>;
}

interface HistogramSeries {
  def: MetricDefinition;
  buckets: number[];
  values: Map<
    string,
    {
      labels: Record<string, string>;
      counts: number[];
      sum: number;
      count: number;
    }
  >;
}

export class MetricsRegistry {
  private counters: Map<string, CounterSeries> = new Map();
  private gauges: Map<string, GaugeSeries> = new Map();
  private histograms: Map<string, HistogramSeries> = new Map();

  registerCounter(def: Omit<MetricDefinition, "kind">): void {
    const full: MetricDefinition = { ...def, kind: "counter" };
    this.counters.set(def.name, { def: full, values: new Map() });
  }

  registerGauge(def: Omit<MetricDefinition, "kind">): void {
    const full: MetricDefinition = { ...def, kind: "gauge" };
    this.gauges.set(def.name, { def: full, values: new Map() });
  }

  registerHistogram(def: Omit<MetricDefinition, "kind">): void {
    if (!def.buckets || def.buckets.length === 0) {
      throw new Error(`histogram ${def.name} requires non-empty buckets`);
    }
    const buckets = [...def.buckets].sort((a, b) => a - b);
    const full: MetricDefinition = { ...def, kind: "histogram", buckets };
    this.histograms.set(def.name, { def: full, buckets, values: new Map() });
  }

  inc(name: string, labels?: LabelValues, by = 1): void {
    const series = this.counters.get(name);
    if (!series) {
      this.warnUnknown("counter", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    const key = labelKey(norm);
    const existing = series.values.get(key);
    if (existing) {
      existing.value += by;
    } else {
      series.values.set(key, { labels: norm, value: by });
    }
  }

  set(name: string, value: number, labels?: LabelValues): void {
    const series = this.gauges.get(name);
    if (!series) {
      this.warnUnknown("gauge", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    series.values.set(labelKey(norm), { labels: norm, value });
  }

  observe(name: string, value: number, labels?: LabelValues): void {
    const series = this.histograms.get(name);
    if (!series) {
      this.warnUnknown("histogram", name);
      return;
    }
    const norm = normalizeLabels(series.def, labels);
    const key = labelKey(norm);
    let entry = series.values.get(key);
    if (!entry) {
      entry = {
        labels: norm,
        counts: new Array(series.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      series.values.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    let landed = false;
    for (let i = 0; i < series.buckets.length; i++) {
      const upper = series.buckets[i] as number;
      if (value <= upper) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
        landed = true;
        break;
      }
    }
    if (!landed) {
      entry.counts[series.buckets.length] = (entry.counts[series.buckets.length] ?? 0) + 1;
    }
  }

  gaugeSum(name: string): number {
    const series = this.gauges.get(name);
    if (!series) return 0;
    let total = 0;
    for (const v of series.values.values()) total += v.value;
    return total;
  }

  gaugeMax(name: string): number {
    const series = this.gauges.get(name);
    if (!series) return 0;
    let max = 0;
    for (const v of series.values.values()) if (v.value > max) max = v.value;
    return max;
  }

  counterSum(name: string): number {
    const series = this.counters.get(name);
    if (!series) return 0;
    let total = 0;
    for (const v of series.values.values()) total += v.value;
    return total;
  }

  counterSumWhere(name: string, predicate: (labels: Record<string, string>) => boolean): number {
    const series = this.counters.get(name);
    if (!series) return 0;
    let total = 0;
    for (const v of series.values.values()) if (predicate(v.labels)) total += v.value;
    return total;
  }

  histogramCount(name: string): number {
    const series = this.histograms.get(name);
    if (!series) return 0;
    let total = 0;
    for (const entry of series.values.values()) total += entry.count;
    return total;
  }

  snapshot(): SeriesSnapshot[] {
    const out: SeriesSnapshot[] = [];
    for (const c of this.counters.values()) {
      const samples: SampleSnapshot[] = [];
      for (const v of c.values.values()) {
        samples.push({ name: c.def.name, labels: v.labels, value: v.value });
      }
      out.push({ name: c.def.name, help: c.def.help, kind: "counter", samples });
    }
    for (const g of this.gauges.values()) {
      const samples: SampleSnapshot[] = [];
      for (const v of g.values.values()) {
        samples.push({ name: g.def.name, labels: v.labels, value: v.value });
      }
      out.push({ name: g.def.name, help: g.def.help, kind: "gauge", samples });
    }
    for (const h of this.histograms.values()) {
      const samples: SampleSnapshot[] = [];
      for (const entry of h.values.values()) {
        let running = 0;
        for (let i = 0; i < h.buckets.length; i++) {
          running += entry.counts[i] ?? 0;
          samples.push({
            name: `${h.def.name}_bucket`,
            labels: { ...entry.labels, le: String(h.buckets[i]) },
            value: running,
          });
        }
        running += entry.counts[h.buckets.length] ?? 0;
        samples.push({
          name: `${h.def.name}_bucket`,
          labels: { ...entry.labels, le: "+Inf" },
          value: running,
        });
        samples.push({
          name: `${h.def.name}_sum`,
          labels: entry.labels,
          value: entry.sum,
        });
        samples.push({
          name: `${h.def.name}_count`,
          labels: entry.labels,
          value: entry.count,
        });
      }
      out.push({ name: h.def.name, help: h.def.help, kind: "histogram", samples });
    }
    return out;
  }

  render(): string {
    const parts: string[] = [];
    for (const series of this.snapshot()) {
      parts.push(`# HELP ${series.name} ${series.help}`);
      parts.push(`# TYPE ${series.name} ${series.kind}`);
      if (series.samples.length === 0) {
        parts.push(`${series.name} 0`);
        continue;
      }
      for (const s of series.samples) {
        const labelKeys = Object.keys(s.labels);
        if (labelKeys.length === 0) {
          parts.push(`${s.name} ${formatNumber(s.value)}`);
        } else {
          const inner = labelKeys
            .map((k) => `${k}="${escapeLabelValue(s.labels[k] ?? "")}"`)
            .join(",");
          parts.push(`${s.name}{${inner}} ${formatNumber(s.value)}`);
        }
      }
    }
    return `${parts.join("\n")}\n`;
  }

  reset(): void {
    for (const c of this.counters.values()) c.values.clear();
    for (const g of this.gauges.values()) g.values.clear();
    for (const h of this.histograms.values()) h.values.clear();
  }

  private warnUnknown(kind: string, name: string): void {
    logger.warn({
      module: "observability",
      action: "metrics.unknown",
      msg: "attempt to write to an unregistered metric",
      kind,
      name,
    });
  }
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) {
    if (n === Number.POSITIVE_INFINITY) return "+Inf";
    if (n === Number.NEGATIVE_INFINITY) return "-Inf";
    return "NaN";
  }
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}
