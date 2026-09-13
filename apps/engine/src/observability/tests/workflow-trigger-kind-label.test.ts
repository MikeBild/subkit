// Guards the label contract on `subkit_workflow_trigger_kind_total`.
// The label set is (tenant_id, kind); both must round-trip from the
// recorder through the exposition. A regression where a future caller
// passes `undefined as unknown as string` would otherwise silently
// produce a `tenant_id=""` time series that masks tenant cohorts.

import { describe, expect, it } from "bun:test";

import { recordWorkflowScheduleNotBound, recordWorkflowTriggerKind } from "../instrumentation.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "../metrics.ts";

describe("workflow trigger-kind metric labels", () => {
  // The registry renders labels in sorted-alphabetical order, so a
  // {kind="X",tenant_id="Y"} time series shows as `kind="X",tenant_id="Y"`.
  // Tests assert both labels are present in the same line; order is
  // not load-bearing for Prometheus consumers.
  function expectMetricLine(text: string, name: string, labels: Record<string, string>) {
    const lines = text.split("\n").filter((l) => l.startsWith(`${name}{`));
    expect(lines.length).toBeGreaterThan(0);
    const match = lines.find((line) =>
      Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`)),
    );
    expect(match).toBeDefined();
  }

  it("round-trips tenant_id + kind for all three known kinds", () => {
    resetMetricsRegistryForTests();
    recordWorkflowTriggerKind({ tenant_id: "tenant-a", kind: "request" });
    recordWorkflowTriggerKind({ tenant_id: "tenant-a", kind: "schedule" });
    recordWorkflowTriggerKind({ tenant_id: "tenant-b", kind: "webhook" });
    const text = getMetrics().render();
    expectMetricLine(text, "subkit_workflow_trigger_kind_total", {
      tenant_id: "tenant-a",
      kind: "request",
    });
    expectMetricLine(text, "subkit_workflow_trigger_kind_total", {
      tenant_id: "tenant-a",
      kind: "schedule",
    });
    expectMetricLine(text, "subkit_workflow_trigger_kind_total", {
      tenant_id: "tenant-b",
      kind: "webhook",
    });
  });

  it("collapses unknown kinds to 'other' so a producer regression cannot blow up cardinality", () => {
    resetMetricsRegistryForTests();
    recordWorkflowTriggerKind({ tenant_id: "tenant-a", kind: "totally-bogus" });
    const text = getMetrics().render();
    expectMetricLine(text, "subkit_workflow_trigger_kind_total", {
      tenant_id: "tenant-a",
      kind: "other",
    });
  });

  it("schedule_not_bound counter carries tenant_id for parity", () => {
    resetMetricsRegistryForTests();
    recordWorkflowScheduleNotBound({ tenant_id: "tenant-c" });
    const text = getMetrics().render();
    expectMetricLine(text, "subkit_workflow_schedule_not_bound_total", {
      tenant_id: "tenant-c",
    });
  });

  it("registry catalog exposes the new metric name", () => {
    expect(METRIC_NAMES.WORKFLOW_TRIGGER_KIND_TOTAL).toBe("subkit_workflow_trigger_kind_total");
  });
});
