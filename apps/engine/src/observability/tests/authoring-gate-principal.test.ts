// Unit tests for recordAuthoringGateBlock with code="principal_required".
//
// The fix added "principal_required" to AUTHORING_GATE_CODES so that
// run_workflow.no_principal events land on a named label bucket rather
// than collapsing to "other". This test asserts that the named bucket is
// incremented correctly and that an unknown code still collapses to "other".

import { beforeEach, describe, expect, it } from "bun:test";
import { recordAuthoringGateBlock } from "../instrumentation.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

function counterSample(labels: Record<string, string>): number | undefined {
  const snap = getMetrics().snapshot();
  const series = snap.find((s) => s.name === METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL);
  if (!series) return undefined;
  const sample = series.samples.find((s) =>
    Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
  return sample?.value;
}

beforeEach(() => {
  resetMetricsRegistryForTests();
});

describe("recordAuthoringGateBlock — principal_required code", () => {
  it("increments the counter for code=principal_required tool=run_workflow", () => {
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBe(1);
  });

  it("accumulates across multiple calls with the same labels", () => {
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBe(3);
  });

  it("does NOT collapse principal_required to the other bucket", () => {
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    // The named bucket should have 1.
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBe(1);
    // The "other" code bucket must be absent for this call.
    expect(counterSample({ code: "other", tool: "run_workflow" })).toBeUndefined();
  });

  it("unknown code collapses to other, not to principal_required", () => {
    recordAuthoringGateBlock({ code: "some_unknown_gate_code", tool: "run_workflow" });
    expect(counterSample({ code: "other", tool: "run_workflow" })).toBe(1);
    expect(counterSample({ code: "some_unknown_gate_code", tool: "run_workflow" })).toBeUndefined();
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBeUndefined();
  });

  it("keeps principal_required and other codes on distinct label sets", () => {
    recordAuthoringGateBlock({ code: "principal_required", tool: "run_workflow" });
    recordAuthoringGateBlock({ code: "workflow_cycle_detected", tool: "build_workflow" });
    expect(counterSample({ code: "principal_required", tool: "run_workflow" })).toBe(1);
    expect(counterSample({ code: "workflow_cycle_detected", tool: "build_workflow" })).toBe(1);
    // No cross-contamination.
    expect(counterSample({ code: "principal_required", tool: "build_workflow" })).toBeUndefined();
    expect(
      counterSample({ code: "workflow_cycle_detected", tool: "run_workflow" }),
    ).toBeUndefined();
  });

  it("unknown tool collapses to other tool bucket", () => {
    recordAuthoringGateBlock({ code: "principal_required", tool: "totally_unknown_tool" });
    expect(counterSample({ code: "principal_required", tool: "other" })).toBe(1);
    expect(
      counterSample({ code: "principal_required", tool: "totally_unknown_tool" }),
    ).toBeUndefined();
  });

  it("principal_required is in the allow-list alongside other recognized codes", () => {
    // Verify all codes in the original allow-list still land on named buckets.
    const knownCodes = [
      "workflow_cycle_detected",
      "workflow_unresolved_step_reference",
      "loop_authoring_requires_inspect",
      "transform_authoring_requires_inspect",
      "repair_loop_detected",
      "critic_rejected",
      "principal_required",
    ];
    for (const code of knownCodes) {
      resetMetricsRegistryForTests();
      recordAuthoringGateBlock({ code, tool: "run_workflow" });
      expect(counterSample({ code, tool: "run_workflow" })).toBe(1);
      expect(counterSample({ code: "other", tool: "run_workflow" })).toBeUndefined();
    }
  });
});
