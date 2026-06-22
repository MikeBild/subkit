// Unit tests for the risk-signal computation layer.
//
// `computeRiskSignals` reads the live metrics registry and config and maps
// gauge/counter values to `RiskSignal` entries. These tests drive the
// registry directly (no DB, no real config) and assert the mapping from
// "gauge value vs threshold" → "RiskSignal kind + severity".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import {
  _resetRssHighWaterForTests,
  recordConnectorCall,
  recordDbTransientRetry,
  recordLlmCallDuration,
  recordLlmFallbackInvocation,
  recordProcessRssHighWater,
  setDbPoolStats,
  setDlqJobCount,
} from "../observability/instrumentation.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../observability/metrics.ts";
import {
  _resetTransientRetryRateForTests,
  sampleTransientRetryRate,
} from "../observability/transient-retry-rate.ts";
import { computeRiskSignals, topRisk } from "./risk-signals.ts";

// Load a minimal config so getConfig() inside computeRiskSignals() resolves.
// The predictive thresholds are tuned in-test via setConfigKey so this just
// seeds the default values (pool_saturation_pct=80, dlq_critical_depth=5,
// transient_retry_rate=1, memory_cap_fraction=0.9).
async function ensureConfig(): Promise<void> {
  try {
    const { getConfig } = await import("../config/loader.ts");
    getConfig();
  } catch {
    const dir = mkdtempSync(join(tmpdir(), "sk-cfg-risk-"));
    await loadConfig({
      env: { DATABASE_URL: "postgres://placeholder/risk-test", NODE_ENV: "test" },
      configPathOverride: join(dir, "subkit.config.json"),
    });
  }
}

beforeEach(async () => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
  _resetTransientRetryRateForTests();
  await ensureConfig();
});

afterEach(() => {
  _resetConfigForTests();
});

describe("computeRiskSignals — no signals when all clear", () => {
  test("returns an empty list when every metric is below threshold", () => {
    // No metrics written → all gauges/counters at zero.
    const signals = computeRiskSignals();
    expect(signals).toEqual([]);
  });
});

describe("computeRiskSignals — pool_saturation", () => {
  test("emits warn when in-use pct ≥ pool_saturation_pct (default 80)", () => {
    // 8 in-use out of 10 = 80% → exactly at threshold.
    setDbPoolStats({ total: 10, idle: 2, waiting: 0 });
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "pool_saturation");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("warn");
    expect(s!.metric).toBeTruthy();
    expect(s!.value).toBe(80);
    expect(s!.threshold).toBe(80);
  });

  test("emits critical when waiting clients > 0", () => {
    setDbPoolStats({ total: 10, idle: 2, waiting: 3 });
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "pool_saturation");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("critical");
    expect(s!.value).toBe(3);
  });

  test("no signal below threshold", () => {
    setDbPoolStats({ total: 10, idle: 3, waiting: 0 }); // 70% < 80%
    const signals = computeRiskSignals();
    expect(signals.find((r) => r.kind === "pool_saturation")).toBeUndefined();
  });
});

describe("computeRiskSignals — dlq_growth", () => {
  test("emits critical when DLQ depth ≥ dlq_critical_depth (default 5)", () => {
    setDlqJobCount("execution.dlq", 5);
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "dlq_growth");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("critical");
    expect(s!.value).toBe(5);
    expect(s!.threshold).toBe(5);
  });

  test("no signal when DLQ is below threshold", () => {
    setDlqJobCount("execution.dlq", 4);
    const signals = computeRiskSignals();
    expect(signals.find((r) => r.kind === "dlq_growth")).toBeUndefined();
  });
});

describe("computeRiskSignals — transient_retry", () => {
  // The signal reads the WINDOWED rate gauge the memory sampler maintains.
  // Drive it deterministically: baseline-sample at t0, record retries, then
  // sample again at t0+Δ with injected nowMs so the rate = retries ÷ Δminutes.
  test("emits warn when the windowed rate ≥ transient_retry_rate (default 1/min)", () => {
    sampleTransientRetryRate({ nowMs: 0 }); // baseline
    for (let i = 0; i < 2; i++) recordDbTransientRetry({ label: "test" });
    sampleTransientRetryRate({ nowMs: 60_000 }); // 2 retries over 1 min → rate 2

    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "transient_retry");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("warn");
    expect(s!.value).toBe(2);
    expect(s!.threshold).toBe(1);
  });

  test("no signal when the windowed rate is below threshold", () => {
    sampleTransientRetryRate({ nowMs: 0 });
    for (let i = 0; i < 5; i++) recordDbTransientRetry({ label: "test" });
    sampleTransientRetryRate({ nowMs: 600_000 }); // 5 retries over 10 min → 0.5/min

    expect(computeRiskSignals().find((r) => r.kind === "transient_retry")).toBeUndefined();
  });

  test("an old blip decays: a quiet window drops the rate back to 0 (no latch)", () => {
    // Spike, then a window with NO new retries → rate returns to 0, proving the
    // windowed gauge is a leading indicator, not a cumulative-÷-uptime latch.
    sampleTransientRetryRate({ nowMs: 0 });
    for (let i = 0; i < 10; i++) recordDbTransientRetry({ label: "test" });
    sampleTransientRetryRate({ nowMs: 60_000 }); // rate 10 → would warn
    sampleTransientRetryRate({ nowMs: 120_000 }); // quiet minute → rate 0

    expect(computeRiskSignals().find((r) => r.kind === "transient_retry")).toBeUndefined();
  });
});

describe("computeRiskSignals — connector_unhealthy", () => {
  test("emits warn when unhealthy share ≥ pool_saturation_pct threshold", () => {
    // 8 ok, 2 auth_failed = 20% unhealthy. That's below 80% — no signal.
    // Use 9 non-ok + 1 ok = 90% unhealthy > 80%.
    for (let i = 0; i < 9; i++) {
      recordConnectorCall({ slug: "slack", health: "auth_failed" });
    }
    recordConnectorCall({ slug: "slack", health: "ok" });
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "connector_unhealthy");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("warn");
    expect(s!.value).toBe(90);
    expect(s!.threshold).toBe(80);
  });

  test("no signal when unhealthy share is below threshold", () => {
    // 1 bad + 9 ok = 10% unhealthy < 80%.
    recordConnectorCall({ slug: "slack", health: "auth_failed" });
    for (let i = 0; i < 9; i++) {
      recordConnectorCall({ slug: "slack", health: "ok" });
    }
    const signals = computeRiskSignals();
    expect(signals.find((r) => r.kind === "connector_unhealthy")).toBeUndefined();
  });
});

describe("computeRiskSignals — llm_fallback", () => {
  test("emits warn when fallback fraction ≥ pool_saturation_pct threshold", () => {
    // 9 fallbacks + 1 primary call = 90% fallback rate > 80%.
    for (let i = 0; i < 9; i++) {
      recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "overloaded" });
    }
    // Record 10 histogram observations so histogramCount = 10.
    for (let i = 0; i < 10; i++) {
      recordLlmCallDuration({
        provider: "gateway",
        model: "haiku",
        flow: "converse",
        duration_ms: 100,
      });
    }
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "llm_fallback");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("warn");
    expect(s!.value).toBe(90);
    expect(s!.threshold).toBe(80);
  });
});

describe("computeRiskSignals — memory_high_water", () => {
  test("emits critical when RSS high-water ≥ memory_cap_fraction of host memory", () => {
    // Use a huge RSS value (1 TB) so the fraction always exceeds the 0.9 cap
    // regardless of the host's actual total memory.
    const ONE_TB = 1_099_511_627_776;
    recordProcessRssHighWater(ONE_TB);
    const signals = computeRiskSignals();
    const s = signals.find((r) => r.kind === "memory_high_water");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("critical");
    expect(s!.threshold).toBe(0.9);
    expect(s!.value).toBeGreaterThanOrEqual(0.9);
  });

  test("no signal when RSS high-water is zero", () => {
    // _resetRssHighWaterForTests already zeroed it; gauge is never set.
    const signals = computeRiskSignals();
    expect(signals.find((r) => r.kind === "memory_high_water")).toBeUndefined();
  });
});

describe("computeRiskSignals — sort order", () => {
  test("critical signals rank before warn signals", () => {
    // Trigger both a critical (waiting pool) and a warn (connector health).
    setDbPoolStats({ total: 10, idle: 2, waiting: 1 });
    for (let i = 0; i < 9; i++) {
      recordConnectorCall({ slug: "jira", health: "auth_failed" });
    }
    recordConnectorCall({ slug: "jira", health: "ok" });
    const signals = computeRiskSignals();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0]!.severity).toBe("critical");
  });
});

describe("topRisk", () => {
  test("returns the first (highest-severity) signal when signals are present", () => {
    setDbPoolStats({ total: 10, idle: 2, waiting: 1 });
    const signals = computeRiskSignals();
    const top = topRisk(signals);
    expect(top).not.toBeNull();
    expect(top!.kind).toBe("pool_saturation");
  });

  test("returns null when the list is empty", () => {
    expect(topRisk([])).toBeNull();
  });
});

describe("computeRiskSignals — config unavailable falls back to empty list", () => {
  test("returns [] when config is not loaded", () => {
    _resetConfigForTests();
    const signals = computeRiskSignals();
    expect(signals).toEqual([]);
  });
});

describe("getMetrics gaugeSum / counterSum / histogramCount read-path contract", () => {
  test("gaugeSum returns 0 for an un-set gauge", () => {
    expect(getMetrics().gaugeSum(METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS)).toBe(0);
  });

  test("counterSum accumulates across label-sets", () => {
    recordConnectorCall({ slug: "a", health: "ok" });
    recordConnectorCall({ slug: "b", health: "ok" });
    expect(getMetrics().counterSum(METRIC_NAMES.CONNECTOR_CALL_TOTAL)).toBe(2);
  });

  test("histogramCount counts observations across label-sets", () => {
    recordLlmCallDuration({ provider: "p", model: "m", flow: "f", duration_ms: 50 });
    recordLlmCallDuration({ provider: "p", model: "m2", flow: "f", duration_ms: 200 });
    expect(getMetrics().histogramCount(METRIC_NAMES.LLM_CALL_DURATION_MS)).toBe(2);
  });
});
