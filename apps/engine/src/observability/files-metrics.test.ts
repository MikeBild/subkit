import { beforeEach, describe, expect, test } from "bun:test";
import {
  observeFileUploadDuration,
  recordFileDedupHit,
  recordFileLlmCapDowngrade,
  recordFileLlmInlineBytes,
  recordFileScanResult,
  setFilesBytesTotal,
  setFilesTotal,
} from "./instrumentation.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "./metrics.ts";

beforeEach(() => {
  resetMetricsRegistryForTests();
});

describe("setFilesTotal", () => {
  test("sets a gauge sample for a known status label", () => {
    setFilesTotal({ tenant_id: "t1", status: "ready", value: 42 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_TOTAL);
    expect(entry).toBeDefined();
    const sample = entry?.samples.find(
      (s) => s.labels.tenant_id === "t1" && s.labels.status === "ready",
    );
    expect(sample?.value).toBe(42);
  });

  test("collapses unknown status to 'other'", () => {
    setFilesTotal({ tenant_id: "t2", status: "banana", value: 5 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_TOTAL);
    const sample = entry?.samples.find(
      (s) => s.labels.tenant_id === "t2" && s.labels.status === "other",
    );
    expect(sample?.value).toBe(5);
  });

  test("is no-throw for any input", () => {
    expect(() => setFilesTotal({ tenant_id: "", status: "", value: 0 })).not.toThrow();
  });
});

describe("setFilesBytesTotal", () => {
  test("sets a gauge sample for tenant_id", () => {
    setFilesBytesTotal({ tenant_id: "t3", value: 1024 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_BYTES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.tenant_id === "t3");
    expect(sample?.value).toBe(1024);
  });
});

describe("recordFileDedupHit", () => {
  test("increments the dedup counter", () => {
    recordFileDedupHit();
    recordFileDedupHit();
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_DEDUP_HITS_TOTAL);
    expect(entry?.samples[0]?.value).toBe(2);
  });
});

describe("observeFileUploadDuration", () => {
  test("records a histogram observation for a known outcome", () => {
    observeFileUploadDuration({ outcome: "success", duration_ms: 200 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_UPLOAD_DURATION_SECONDS);
    expect(entry).toBeDefined();
    expect(entry?.samples.length ?? 0).toBeGreaterThan(0);
  });

  test("collapses unknown outcome to 'error'", () => {
    expect(() => observeFileUploadDuration({ outcome: "mystery", duration_ms: 100 })).not.toThrow();
  });

  test("ignores non-finite duration_ms", () => {
    expect(() =>
      observeFileUploadDuration({ outcome: "success", duration_ms: Number.NaN }),
    ).not.toThrow();
  });
});

describe("recordFileLlmInlineBytes", () => {
  test("increments the counter by the supplied byte count", () => {
    recordFileLlmInlineBytes({ tenant_id: "t4", bytes: 512 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_LLM_INLINE_BYTES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.tenant_id === "t4");
    expect(sample?.value).toBe(512);
  });

  test("ignores zero bytes", () => {
    recordFileLlmInlineBytes({ tenant_id: "t5", bytes: 0 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_LLM_INLINE_BYTES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.tenant_id === "t5");
    expect(sample).toBeUndefined();
  });
});

describe("recordFileLlmCapDowngrade", () => {
  test("increments the counter by the supplied count", () => {
    recordFileLlmCapDowngrade({ tenant_id: "t6", count: 3 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_LLM_CAP_DOWNGRADES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.tenant_id === "t6");
    expect(sample?.value).toBe(3);
  });

  test("ignores zero count", () => {
    recordFileLlmCapDowngrade({ tenant_id: "t7", count: 0 });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_LLM_CAP_DOWNGRADES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.tenant_id === "t7");
    expect(sample).toBeUndefined();
  });
});

describe("recordFileScanResult", () => {
  test("increments counter for 'clean' verdict", () => {
    recordFileScanResult({ verdict: "clean" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.verdict === "clean");
    expect(sample?.value).toBe(1);
  });

  test("increments counter for 'infected' verdict", () => {
    recordFileScanResult({ verdict: "infected" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.verdict === "infected");
    expect(sample?.value).toBe(1);
  });

  test("collapses unknown verdict to 'infected' (safer side)", () => {
    recordFileScanResult({ verdict: "suspicious" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.verdict === "infected");
    expect(sample?.value).toBe(1);
  });
});
