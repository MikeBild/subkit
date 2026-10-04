import { beforeEach, describe, expect, it } from "bun:test";
import {
  recordAuthoringContextSkillsUsed,
  recordLoopDriftToPatchCandidate,
  recordLoopPatchToSkillCandidate,
  recordLoopSkillCandidatePromoted,
} from "../instrumentation.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

function counterSample(metricName: string, labels: Record<string, string>): number | undefined {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === metricName);
  if (!series) return undefined;
  const sample = series.samples.find((s) =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return sample?.value;
}

function histogramCount(metricName: string, labels: Record<string, string>): number {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === metricName);
  if (!series) return 0;
  const countSample = series.samples.find(
    (s) =>
      s.name === `${metricName}_count` &&
      Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return countSample?.value ?? 0;
}

function histogramSum(metricName: string, labels: Record<string, string>): number {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === metricName);
  if (!series) return 0;
  const sumSample = series.samples.find(
    (s) =>
      s.name === `${metricName}_sum` && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return sumSample?.value ?? 0;
}

beforeEach(() => {
  resetMetricsRegistryForTests();
});

describe("recordAuthoringContextSkillsUsed", () => {
  it("increments by count=1 for a single catalog call", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "catalog", count: 1 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "catalog",
      }),
    ).toBe(1);
  });

  it("increments by the supplied count (count=3 → value 3)", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "catalog", count: 3 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "catalog",
      }),
    ).toBe(3);
  });

  it("is a no-op when count is zero", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "catalog", count: 0 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "catalog",
      }),
    ).toBeUndefined();
  });

  it("is a no-op when count is negative", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "catalog", count: -5 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "catalog",
      }),
    ).toBeUndefined();
  });

  it("keeps catalog and candidate sources as distinct samples", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "catalog", count: 2 });
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-a", source: "candidate", count: 5 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "catalog",
      }),
    ).toBe(2);
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-a",
        source: "candidate",
      }),
    ).toBe(5);
  });

  it("scopes samples per tenant_id (two tenants stay isolated)", () => {
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-x", source: "catalog", count: 1 });
    recordAuthoringContextSkillsUsed({ tenant_id: "tenant-y", source: "catalog", count: 4 });
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-x",
        source: "catalog",
      }),
    ).toBe(1);
    expect(
      counterSample(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL, {
        tenant_id: "tenant-y",
        source: "catalog",
      }),
    ).toBe(4);
  });
});

describe("recordLoopDriftToPatchCandidate", () => {
  it("increments by 1 for a single call with classifier=safe", () => {
    recordLoopDriftToPatchCandidate({ tenant_id: "tenant-a", classifier: "safe" });
    expect(
      counterSample(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
        tenant_id: "tenant-a",
        classifier: "safe",
      }),
    ).toBe(1);
  });

  it("increments by 1 for classifier=unsafe on the correct label set", () => {
    recordLoopDriftToPatchCandidate({ tenant_id: "tenant-a", classifier: "unsafe" });
    expect(
      counterSample(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
        tenant_id: "tenant-a",
        classifier: "unsafe",
      }),
    ).toBe(1);
  });

  it("does not cross-contaminate safe and unsafe classifiers", () => {
    recordLoopDriftToPatchCandidate({ tenant_id: "tenant-a", classifier: "safe" });
    expect(
      counterSample(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
        tenant_id: "tenant-a",
        classifier: "unsafe",
      }),
    ).toBeUndefined();
  });

  it("scopes samples per tenant_id", () => {
    recordLoopDriftToPatchCandidate({ tenant_id: "tenant-1", classifier: "safe" });
    recordLoopDriftToPatchCandidate({ tenant_id: "tenant-2", classifier: "safe" });
    expect(
      counterSample(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
        tenant_id: "tenant-1",
        classifier: "safe",
      }),
    ).toBe(1);
    expect(
      counterSample(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
        tenant_id: "tenant-2",
        classifier: "safe",
      }),
    ).toBe(1);
  });
});

describe("recordLoopPatchToSkillCandidate", () => {
  it("increments by 1 for a single call with the correct tenant_id label", () => {
    recordLoopPatchToSkillCandidate({ tenant_id: "tenant-a" });
    expect(
      counterSample(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL, {
        tenant_id: "tenant-a",
      }),
    ).toBe(1);
  });

  it("accumulates across multiple calls", () => {
    recordLoopPatchToSkillCandidate({ tenant_id: "tenant-a" });
    recordLoopPatchToSkillCandidate({ tenant_id: "tenant-a" });
    expect(
      counterSample(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL, {
        tenant_id: "tenant-a",
      }),
    ).toBe(2);
  });

  it("scopes samples per tenant_id", () => {
    recordLoopPatchToSkillCandidate({ tenant_id: "tenant-p" });
    recordLoopPatchToSkillCandidate({ tenant_id: "tenant-q" });
    expect(
      counterSample(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL, {
        tenant_id: "tenant-p",
      }),
    ).toBe(1);
    expect(
      counterSample(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL, {
        tenant_id: "tenant-q",
      }),
    ).toBe(1);
  });
});

describe("recordLoopSkillCandidatePromoted", () => {
  it("increments the promoted counter by 1 for source=auto-suggested", () => {
    recordLoopSkillCandidatePromoted({ tenant_id: "tenant-a", source: "auto-suggested" });
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-a",
        source: "auto-suggested",
      }),
    ).toBe(1);
  });

  it("increments the promoted counter by 1 for source=manual", () => {
    recordLoopSkillCandidatePromoted({ tenant_id: "tenant-a", source: "manual" });
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-a",
        source: "manual",
      }),
    ).toBe(1);
  });

  it("keeps auto-suggested and manual source labels as distinct samples", () => {
    recordLoopSkillCandidatePromoted({ tenant_id: "tenant-a", source: "auto-suggested" });
    recordLoopSkillCandidatePromoted({ tenant_id: "tenant-a", source: "manual" });
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-a",
        source: "auto-suggested",
      }),
    ).toBe(1);
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-a",
        source: "manual",
      }),
    ).toBe(1);
  });

  it("records exactly one histogram observation when lag_seconds is provided", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
      lag_seconds: 120,
    });
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(1);
    expect(
      histogramSum(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(120);
  });

  it("places the observation in the correct bucket (120s → le=300 bucket)", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
      lag_seconds: 120,
    });
    const snap = getMetrics().snapshot();
    const series = snap.find((s) => s.name === METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS);
    const le60 = series?.samples.find(
      (s) =>
        s.name === `${METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS}_bucket` &&
        s.labels.le === "60" &&
        s.labels.tenant_id === "tenant-a",
    );
    const le300 = series?.samples.find(
      (s) =>
        s.name === `${METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS}_bucket` &&
        s.labels.le === "300" &&
        s.labels.tenant_id === "tenant-a",
    );
    expect(le60?.value).toBe(0);
    expect(le300?.value).toBe(1);
  });

  it("does NOT record a histogram observation when lag_seconds is omitted", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
    });
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-a",
        source: "auto-suggested",
      }),
    ).toBe(1);
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(0);
  });

  it("does NOT record a histogram observation when lag_seconds is non-finite", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
      lag_seconds: Number.NaN,
    });
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(0);
  });

  it("records two observations for two calls each with distinct lag_seconds", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
      lag_seconds: 60,
    });
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-a",
      source: "auto-suggested",
      lag_seconds: 3600,
    });
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(2);
    expect(
      histogramSum(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-a",
      }),
    ).toBe(3660);
  });

  it("scopes promoted counter and lag histogram samples per tenant_id", () => {
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-m",
      source: "auto-suggested",
      lag_seconds: 300,
    });
    recordLoopSkillCandidatePromoted({
      tenant_id: "tenant-n",
      source: "auto-suggested",
      lag_seconds: 600,
    });
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-m",
        source: "auto-suggested",
      }),
    ).toBe(1);
    expect(
      counterSample(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
        tenant_id: "tenant-n",
        source: "auto-suggested",
      }),
    ).toBe(1);
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-m",
      }),
    ).toBe(1);
    expect(
      histogramSum(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-m",
      }),
    ).toBe(300);
    expect(
      histogramCount(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-n",
      }),
    ).toBe(1);
    expect(
      histogramSum(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, {
        tenant_id: "tenant-n",
      }),
    ).toBe(600);
  });
});

describe("METRIC_NAMES catalog entries for the loop-closure series", () => {
  it("exports the correct metric name strings", () => {
    expect(METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL).toBe(
      "sk_authoring_context_skills_used_total",
    );
    expect(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL).toBe(
      "sk_loop_drift_to_patch_candidate_total",
    );
    expect(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL).toBe(
      "sk_loop_patch_to_skill_candidate_total",
    );
    expect(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL).toBe(
      "sk_loop_skill_candidate_promoted_total",
    );
    expect(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS).toBe("sk_loop_drift_to_skill_lag_seconds");
  });

  it("lag histogram is registered with the correct bucket boundaries", () => {
    resetMetricsRegistryForTests();
    const text = getMetrics().render();
    expect(text).toContain(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS);
  });
});
