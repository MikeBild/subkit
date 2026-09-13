// Phase 2 predictive-maintenance metrics — invocation contract tests.
//
// Mirrors files-metrics.test.ts: verifies each helper from
// `instrumentation.ts` records the expected sample(s), collapses unknown
// label values per the allow-list, and never throws. The RSS high-water
// helper additionally asserts its climb-only semantics.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetRssHighWaterForTests,
  recordConnectorCall,
  recordDbTransientRetry,
  recordLlmCallDuration,
  recordLlmFallbackInvocation,
  recordProcessRssHighWater,
  setDbPoolStats,
  setDlqJobCount,
} from "./instrumentation.ts";
import {
  _resetConnectorSlugBudgetForTests,
  boundedConnectorSlug,
} from "./metric-label-allowlists.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "./metrics.ts";
import {
  _resetTransientRetryRateForTests,
  sampleTransientRetryRate,
} from "./transient-retry-rate.ts";

beforeEach(() => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  _resetTransientRetryRateForTests();
  _resetConnectorSlugBudgetForTests();
});

describe("setDbPoolStats", () => {
  test("sets the three pool gauges", () => {
    setDbPoolStats({ total: 10, idle: 7, waiting: 2 });
    const snap = getMetrics().snapshot();
    const total = snap.find((s) => s.name === METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS);
    const idle = snap.find((s) => s.name === METRIC_NAMES.DB_POOL_IDLE_CONNECTIONS);
    const waiting = snap.find((s) => s.name === METRIC_NAMES.DB_POOL_WAITING_CONNECTIONS);
    expect(total?.samples[0]?.value).toBe(10);
    expect(idle?.samples[0]?.value).toBe(7);
    expect(waiting?.samples[0]?.value).toBe(2);
  });

  test("is no-throw for any input", () => {
    expect(() => setDbPoolStats({ total: 0, idle: 0, waiting: 0 })).not.toThrow();
  });
});

describe("recordDbTransientRetry", () => {
  test("increments the counter under the supplied label", () => {
    recordDbTransientRetry({ label: "docs_auto_refresh" });
    recordDbTransientRetry({ label: "docs_auto_refresh" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.label === "docs_auto_refresh");
    expect(sample?.value).toBe(2);
  });

  test("defaults the label to empty when omitted", () => {
    recordDbTransientRetry({});
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.label === "");
    expect(sample?.value).toBe(1);
  });
});

describe("setDlqJobCount", () => {
  test("sets the gauge per dead-letter queue", () => {
    setDlqJobCount("execution.dlq", 4);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DLQ_JOB_COUNT);
    const sample = entry?.samples.find((s) => s.labels.queue === "execution.dlq");
    expect(sample?.value).toBe(4);
  });
});

describe("recordConnectorCall", () => {
  test("increments the counter for a known health verdict", () => {
    recordConnectorCall({ slug: "jira", health: "auth_failed" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const sample = entry?.samples.find(
      (s) => s.labels.slug === "jira" && s.labels.health === "auth_failed",
    );
    expect(sample?.value).toBe(1);
  });

  test("collapses an unknown health verdict to 'other'", () => {
    recordConnectorCall({ slug: "jira", health: "mystery" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const sample = entry?.samples.find(
      (s) => s.labels.slug === "jira" && s.labels.health === "other",
    );
    expect(sample?.value).toBe(1);
  });
});

describe("recordLlmCallDuration", () => {
  test("records a histogram observation", () => {
    recordLlmCallDuration({
      provider: "gateway",
      model: "claude-haiku-4-5",
      flow: "converse",
      duration_ms: 1200,
    });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.LLM_CALL_DURATION_MS);
    expect(entry).toBeDefined();
    expect(entry?.samples.length ?? 0).toBeGreaterThan(0);
  });

  test("ignores non-finite duration", () => {
    expect(() =>
      recordLlmCallDuration({
        provider: "gateway",
        model: "m",
        flow: "converse",
        duration_ms: Number.NaN,
      }),
    ).not.toThrow();
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.LLM_CALL_DURATION_MS);
    expect(entry?.samples.length ?? 0).toBe(0);
  });
});

describe("recordLlmFallbackInvocation", () => {
  test("increments the counter partitioned by from/to/reason", () => {
    recordLlmFallbackInvocation({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-6",
      reason: "overloaded",
    });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL);
    const sample = entry?.samples.find(
      (s) =>
        s.labels.from === "claude-haiku-4-5" &&
        s.labels.to === "claude-sonnet-4-6" &&
        s.labels.reason === "overloaded",
    );
    expect(sample?.value).toBe(1);
  });
});

describe("recordProcessRssHighWater", () => {
  test("sets the gauge on first observation", () => {
    recordProcessRssHighWater(1000);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES);
    expect(entry?.samples[0]?.value).toBe(1000);
  });

  test("climbs only — a lower RSS does not lower the high-water mark", () => {
    recordProcessRssHighWater(2000);
    recordProcessRssHighWater(500);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES);
    expect(entry?.samples[0]?.value).toBe(2000);
  });

  test("advances when a higher RSS arrives", () => {
    recordProcessRssHighWater(2000);
    recordProcessRssHighWater(3000);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES);
    expect(entry?.samples[0]?.value).toBe(3000);
  });
});

describe("boundedConnectorSlug (cardinality cap)", () => {
  test("passes through known slugs and collapses overflow to 'other'", () => {
    // First 200 distinct slugs each keep their identity.
    for (let i = 0; i < 200; i++) {
      expect(boundedConnectorSlug(`slug-${i}`)).toBe(`slug-${i}`);
    }
    // An already-seen slug still passes through (idempotent).
    expect(boundedConnectorSlug("slug-0")).toBe("slug-0");
    // The 201st DISTINCT slug overflows the budget → "other".
    expect(boundedConnectorSlug("slug-200")).toBe("other");
  });
});

describe("sampleTransientRetryRate (windowed)", () => {
  const rateGauge = (): number | undefined =>
    getMetrics()
      .snapshot()
      .find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRY_RATE_PER_MIN)?.samples[0]?.value;

  test("first call only establishes the baseline — no rate yet", () => {
    recordDbTransientRetry({ label: "drift_scan" });
    sampleTransientRetryRate({ nowMs: 0 });
    expect(rateGauge()).toBeUndefined();
  });

  test("charts the delta over the elapsed window (retries ÷ minutes)", () => {
    sampleTransientRetryRate({ nowMs: 0 });
    for (let i = 0; i < 6; i++) recordDbTransientRetry({ label: "drift_scan" });
    sampleTransientRetryRate({ nowMs: 120_000 }); // 6 retries over 2 min → 3/min
    expect(rateGauge()).toBe(3);
  });

  test("a quiet window decays the rate back to 0 (no latch)", () => {
    sampleTransientRetryRate({ nowMs: 0 });
    for (let i = 0; i < 10; i++) recordDbTransientRetry({ label: "drift_scan" });
    sampleTransientRetryRate({ nowMs: 60_000 }); // 10/min
    expect(rateGauge()).toBe(10);
    sampleTransientRetryRate({ nowMs: 120_000 }); // no new retries → 0
    expect(rateGauge()).toBe(0);
  });
});
