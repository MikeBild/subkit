import { beforeEach, describe, expect, test } from "bun:test";
import { TASK_ADMISSION_REASONS, TASK_RUN_TRIGGERS } from "../tasks/types.ts";
import { recordDbTransientRetry } from "./instrumentation.ts";
import {
  TASK_ADMISSION_REASON_LABELS,
  TASK_RUN_TRIGGER_LABELS,
} from "./metric-label-allowlists.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "./metrics.ts";
import { recordTaskAdmission, recordTaskRunOutcome, recordTaskSweepClaim } from "./task-metrics.ts";

const TENANT = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  resetMetricsRegistryForTests();
});

function samplesOf(name: string) {
  return (
    getMetrics()
      .snapshot()
      .find((series) => series.name === name)?.samples ?? []
  );
}

function counters(name: string) {
  return samplesOf(name)
    .filter((sample) => sample.name === name)
    .map((sample) => ({ labels: sample.labels, value: sample.value }));
}

describe("task metric families", () => {
  test("the four families are registered with their kinds", () => {
    const rendered = getMetrics().render();
    expect(rendered).toContain("# TYPE subkit_task_run_total counter");
    expect(rendered).toContain("# TYPE subkit_task_run_duration_ms histogram");
    expect(rendered).toContain("# TYPE subkit_task_sweep_claim_total counter");
    expect(rendered).toContain("# TYPE subkit_task_admission_total counter");
  });

  test("the allow-lists hold exactly the task vocabulary", () => {
    expect([...TASK_ADMISSION_REASON_LABELS].sort()).toEqual([...TASK_ADMISSION_REASONS].sort());
    expect([...TASK_RUN_TRIGGER_LABELS].sort()).toEqual([...TASK_RUN_TRIGGERS].sort());
  });
});

describe("recordTaskRunOutcome", () => {
  test("a started run is counted and has no duration", () => {
    recordTaskRunOutcome({
      tenant_id: TENANT,
      outcome: "started",
      trigger: "cron",
      duration_ms: 5,
    });
    expect(counters(METRIC_NAMES.TASK_RUN_TOTAL)).toEqual([
      { labels: { outcome: "started", tenant_id: TENANT, trigger: "cron" }, value: 1 },
    ]);
    expect(samplesOf(METRIC_NAMES.TASK_RUN_DURATION_MS)).toEqual([]);
  });

  test("an ended run is counted by outcome and observed once", () => {
    recordTaskRunOutcome({
      tenant_id: TENANT,
      outcome: "completed",
      trigger: "manual",
      duration_ms: 90_000,
    });
    recordTaskRunOutcome({ tenant_id: TENANT, outcome: "failed", trigger: "manual" });
    expect(counters(METRIC_NAMES.TASK_RUN_TOTAL)).toEqual([
      { labels: { outcome: "completed", tenant_id: TENANT, trigger: "manual" }, value: 1 },
      { labels: { outcome: "failed", tenant_id: TENANT, trigger: "manual" }, value: 1 },
    ]);
    const duration = samplesOf(METRIC_NAMES.TASK_RUN_DURATION_MS);
    const count = duration.find((sample) => sample.name.endsWith("_count"));
    const sum = duration.find((sample) => sample.name.endsWith("_sum"));
    expect(count?.value).toBe(1);
    expect(count?.labels).toEqual({ outcome: "completed", tenant_id: TENANT });
    expect(sum?.value).toBe(90_000);
  });

  test("a missing, negative or non-finite duration is not observed", () => {
    for (const duration_ms of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      recordTaskRunOutcome({ tenant_id: TENANT, outcome: "aborted", trigger: "once", duration_ms });
    }
    expect(counters(METRIC_NAMES.TASK_RUN_TOTAL)[0]?.value).toBe(5);
    expect(samplesOf(METRIC_NAMES.TASK_RUN_DURATION_MS)).toEqual([]);
  });

  test("an unknown outcome or trigger collapses into other", () => {
    recordTaskRunOutcome({
      tenant_id: TENANT,
      outcome: "Weekly revenue report" as never,
      trigger: "the owner asked for it",
      duration_ms: 10,
    });
    expect(counters(METRIC_NAMES.TASK_RUN_TOTAL)).toEqual([
      { labels: { outcome: "other", tenant_id: TENANT, trigger: "other" }, value: 1 },
    ]);
    const count = samplesOf(METRIC_NAMES.TASK_RUN_DURATION_MS).find((sample) =>
      sample.name.endsWith("_count"),
    );
    expect(count?.labels).toEqual({ outcome: "other", tenant_id: TENANT });
  });

  test("a task name or id never becomes a label, even when written directly", () => {
    getMetrics().inc(METRIC_NAMES.TASK_RUN_TOTAL, {
      tenant_id: TENANT,
      outcome: "started",
      trigger: "cron",
      task_id: "11111111-1111-4111-8111-111111111111",
      task_name: "Weekly revenue report",
    });
    const [sample] = counters(METRIC_NAMES.TASK_RUN_TOTAL);
    expect(Object.keys(sample?.labels ?? {}).sort()).toEqual(["outcome", "tenant_id", "trigger"]);
  });
});

describe("recordTaskSweepClaim and recordTaskAdmission", () => {
  test("a sweep claim is counted by result only", () => {
    recordTaskSweepClaim({ result: "claimed" });
    recordTaskSweepClaim({ result: "claimed" });
    recordTaskSweepClaim({ result: "held" });
    recordTaskSweepClaim({ result: "unexpected" as never });
    expect(counters(METRIC_NAMES.TASK_SWEEP_CLAIM_TOTAL)).toEqual([
      { labels: { result: "claimed" }, value: 2 },
      { labels: { result: "held" }, value: 1 },
      { labels: { result: "other" }, value: 1 },
    ]);
  });

  test("every admission reason code is its own series and free text is not", () => {
    for (const reason of TASK_ADMISSION_REASONS) recordTaskAdmission({ reason });
    recordTaskAdmission({ reason: "grant_expired on 2026-11-19 for Weekly revenue report" });
    const series = counters(METRIC_NAMES.TASK_ADMISSION_TOTAL);
    expect(series.map((sample) => sample.labels.reason).sort()).toEqual(
      [...TASK_ADMISSION_REASONS, "other"].sort(),
    );
    expect(series.every((sample) => sample.value === 1)).toBe(true);
  });

  test("the task sweep has its own transient retry label", () => {
    recordDbTransientRetry({ label: "task_schedules" });
    expect(counters(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL)).toEqual([
      { labels: { label: "task_schedules" }, value: 1 },
    ]);
  });
});
