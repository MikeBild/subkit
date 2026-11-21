import { describe, expect, it } from "bun:test";
import {
  getMetrics,
  METRIC_NAMES,
  MetricsRegistry,
  resetMetricsRegistryForTests,
} from "../metrics.ts";

interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseExposition(text: string): {
  helps: Map<string, string>;
  types: Map<string, string>;
  samples: ParsedSample[];
} {
  const helps = new Map<string, string>();
  const types = new Map<string, string>();
  const samples: ParsedSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# HELP")) {
      const m = /^# HELP (\S+) (.*)$/.exec(line);
      if (m?.[1]) helps.set(m[1], m[2] ?? "");
      continue;
    }
    if (line.startsWith("# TYPE")) {
      const m = /^# TYPE (\S+) (\S+)$/.exec(line);
      if (m?.[1] && m?.[2]) types.set(m[1], m[2]);
      continue;
    }
    const labelMatch = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!labelMatch) continue;
    const name = labelMatch[1] as string;
    const labelBody = labelMatch[2] ?? "";
    const valueRaw = labelMatch[3] as string;
    const labels: Record<string, string> = {};
    if (labelBody) {
      for (const pair of labelBody.split(",")) {
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const k = pair.slice(0, eq).trim();
        const vRaw = pair.slice(eq + 1).trim();
        labels[k] = vRaw.startsWith('"') ? vRaw.slice(1, -1) : vRaw;
      }
    }
    samples.push({
      name,
      labels,
      value: valueRaw === "+Inf" ? Number.POSITIVE_INFINITY : Number(valueRaw),
    });
  }
  return { helps, types, samples };
}

describe("MetricsRegistry", () => {
  it("renders counter, gauge and histogram round-trips", () => {
    const reg = new MetricsRegistry();
    reg.registerCounter({
      name: "demo_counter_total",
      help: "Demo counter",
      labels: ["status"],
    });
    reg.registerGauge({
      name: "demo_gauge",
      help: "Demo gauge",
      labels: ["queue"],
    });
    reg.registerHistogram({
      name: "demo_duration_ms",
      help: "Demo histogram",
      labels: ["op"],
      buckets: [10, 100, 1000],
    });

    reg.inc("demo_counter_total", { status: "ok" });
    reg.inc("demo_counter_total", { status: "ok" });
    reg.inc("demo_counter_total", { status: "fail" });
    reg.set("demo_gauge", 42, { queue: "execution.run" });
    reg.observe("demo_duration_ms", 5, { op: "find" });
    reg.observe("demo_duration_ms", 50, { op: "find" });
    reg.observe("demo_duration_ms", 500, { op: "find" });
    reg.observe("demo_duration_ms", 5000, { op: "find" });

    const text = reg.render();
    const parsed = parseExposition(text);

    expect(parsed.types.get("demo_counter_total")).toBe("counter");
    expect(parsed.types.get("demo_gauge")).toBe("gauge");
    expect(parsed.types.get("demo_duration_ms")).toBe("histogram");
    expect(parsed.helps.get("demo_counter_total")).toBe("Demo counter");

    const ok = parsed.samples.find(
      (s) => s.name === "demo_counter_total" && s.labels.status === "ok",
    );
    expect(ok?.value).toBe(2);
    const fail = parsed.samples.find(
      (s) => s.name === "demo_counter_total" && s.labels.status === "fail",
    );
    expect(fail?.value).toBe(1);

    const gauge = parsed.samples.find(
      (s) => s.name === "demo_gauge" && s.labels.queue === "execution.run",
    );
    expect(gauge?.value).toBe(42);

    const buckets = parsed.samples
      .filter((s) => s.name === "demo_duration_ms_bucket" && s.labels.op === "find")
      .sort(
        (a, b) =>
          Number(a.labels.le === "+Inf" ? Infinity : a.labels.le) -
          Number(b.labels.le === "+Inf" ? Infinity : b.labels.le),
      );
    expect(buckets.length).toBe(4);
    expect(buckets[0]?.value).toBe(1);
    expect(buckets[1]?.value).toBe(2);
    expect(buckets[2]?.value).toBe(3);
    expect(buckets[3]?.value).toBe(4);

    const sum = parsed.samples.find((s) => s.name === "demo_duration_ms_sum");
    expect(sum?.value).toBe(5555);
    const count = parsed.samples.find((s) => s.name === "demo_duration_ms_count");
    expect(count?.value).toBe(4);
  });

  it("canonical registry exposes every required series after a fresh reset", () => {
    resetMetricsRegistryForTests();
    const text = getMetrics().render();
    const parsed = parseExposition(text);
    const requiredCounters = [
      METRIC_NAMES.EXECUTION_TOTAL,
      METRIC_NAMES.REQUEST_RETRY_TOTAL,
      METRIC_NAMES.WEBHOOK_DELIVERY_TOTAL,
      METRIC_NAMES.CHAT_DELIVERY_TOTAL,
      METRIC_NAMES.LLM_TOKENS_TOTAL,
      METRIC_NAMES.LLM_SPEND_LIMIT_REACHED_TOTAL,
      METRIC_NAMES.PATCH_CANDIDATES_TOTAL,
      METRIC_NAMES.HTTP_REQUESTS_TOTAL,
    ];
    const requiredGauges = [
      METRIC_NAMES.QUEUE_DEPTH,
      METRIC_NAMES.QUEUE_LAG_MS,
      METRIC_NAMES.OUTBOX_CURSOR_LAG,
      METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    ];
    const requiredHistograms = [
      METRIC_NAMES.EXECUTION_DURATION_MS,
      METRIC_NAMES.HTTP_REQUEST_DURATION_MS,
    ];
    for (const c of requiredCounters) {
      expect(parsed.types.get(c)).toBe("counter");
    }
    for (const g of requiredGauges) {
      expect(parsed.types.get(g)).toBe("gauge");
    }
    for (const h of requiredHistograms) {
      expect(parsed.types.get(h)).toBe("histogram");
    }
  });
});
