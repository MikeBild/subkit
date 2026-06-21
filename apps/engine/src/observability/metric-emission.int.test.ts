// Integration tests for Phase-2 predictive-maintenance metric helpers.
//
// These tests use the live metrics registry (no DB required) to assert that
// each instrumentation helper records the expected counter / gauge change when
// driven by the four scenarios the plan specifies:
//   1. transient DB retry
//   2. DLQ insert (gauge set to non-zero)
//   3. connector error (non-ok health label)
//   4. LLM fallback invocation
//
// The registry is reset between tests via resetMetricsRegistryForTests() so
// each case starts from zero.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetRssHighWaterForTests,
  recordConnectorCall,
  recordDbTransientRetry,
  recordLlmFallbackInvocation,
  setDlqJobCount,
} from "./instrumentation.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "./metrics.ts";

beforeEach(() => {
  resetMetricsRegistryForTests();
  _resetRssHighWaterForTests();
});

describe("transient retry counter", () => {
  test("increments db_transient_retries_total on each recordDbTransientRetry call", () => {
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "drift_scan" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.label === "drift_scan");
    expect(sample?.value).toBe(3);
  });

  test("counter for different labels are independent", () => {
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "workflow_schedules" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const drift = entry?.samples.find((s) => s.labels.label === "drift_scan");
    const sched = entry?.samples.find((s) => s.labels.label === "workflow_schedules");
    expect(drift?.value).toBe(1);
    expect(sched?.value).toBe(1);
  });

  test('an off-allow-list label collapses to "other" (cardinality guard)', () => {
    recordDbTransientRetry({ label: "workflow-abc123" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    expect(entry?.samples.find((s) => s.labels.label === "workflow-abc123")).toBeUndefined();
    expect(entry?.samples.find((s) => s.labels.label === "other")?.value).toBe(1);
  });
});

describe("DLQ depth gauge", () => {
  test("dlq_job_count reflects the current depth after setDlqJobCount", () => {
    setDlqJobCount("execution.dlq", 7);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DLQ_JOB_COUNT);
    const sample = entry?.samples.find((s) => s.labels.queue === "execution.dlq");
    expect(sample?.value).toBe(7);
  });

  test("gauge is overwritten (not accumulated) on repeated sets", () => {
    setDlqJobCount("execution.dlq", 7);
    setDlqJobCount("execution.dlq", 2); // jobs were re-queued or cleared
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DLQ_JOB_COUNT);
    const sample = entry?.samples.find((s) => s.labels.queue === "execution.dlq");
    expect(sample?.value).toBe(2);
  });

  test("gaugeSum aggregates across DLQ partitions", () => {
    setDlqJobCount("execution.dlq", 3);
    setDlqJobCount("conversation.dlq", 2);
    expect(getMetrics().gaugeSum(METRIC_NAMES.DLQ_JOB_COUNT)).toBe(5);
  });
});

describe("connector error counter", () => {
  test("connector_call_total increments for a non-ok health verdict", () => {
    recordConnectorCall({ slug: "github", health: "auth_failed" });
    recordConnectorCall({ slug: "github", health: "auth_failed" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const sample = entry?.samples.find(
      (s) => s.labels.slug === "github" && s.labels.health === "auth_failed",
    );
    expect(sample?.value).toBe(2);
  });

  test("ok and non-ok calls are partitioned separately", () => {
    recordConnectorCall({ slug: "github", health: "ok" });
    recordConnectorCall({ slug: "github", health: "endpoint_gone" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const ok = entry?.samples.find((s) => s.labels.health === "ok");
    const gone = entry?.samples.find((s) => s.labels.health === "endpoint_gone");
    expect(ok?.value).toBe(1);
    expect(gone?.value).toBe(1);
  });

  test("counterSumWhere isolates non-ok calls across slugs", () => {
    recordConnectorCall({ slug: "github", health: "ok" });
    recordConnectorCall({ slug: "jira", health: "auth_failed" });
    recordConnectorCall({ slug: "jira", health: "endpoint_gone" });
    const unhealthy = getMetrics().counterSumWhere(
      METRIC_NAMES.CONNECTOR_CALL_TOTAL,
      (l) => l.health !== "ok",
    );
    expect(unhealthy).toBe(2);
  });
});

describe("LLM fallback counter", () => {
  test("llm_fallback_invocations_total increments on each recordLlmFallbackInvocation", () => {
    recordLlmFallbackInvocation({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-6",
      reason: "overloaded",
    });
    recordLlmFallbackInvocation({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-6",
      reason: "rate_limit",
    });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL);
    const overloaded = entry?.samples.find((s) => s.labels.reason === "overloaded");
    const rateLimit = entry?.samples.find((s) => s.labels.reason === "rate_limit");
    expect(overloaded?.value).toBe(1);
    expect(rateLimit?.value).toBe(1);
  });

  test("counterSum aggregates all fallbacks regardless of reason", () => {
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "overloaded" });
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "rate_limit" });
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "timeout" });
    expect(getMetrics().counterSum(METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL)).toBe(3);
  });
});
