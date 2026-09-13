// Cardinality guard tests. We declare a metric with a small allow-list
// and confirm:
//
//   1. A write that includes a label outside the allow-list still
//      records the sample, but the rogue label is silently dropped.
//   2. Multiple writes that vary on the rogue label collapse onto a
//      single series (no cardinality explosion).
//   3. Missing allow-listed labels are filled in with the empty string
//      so the series shape stays consistent.

import { describe, expect, it } from "bun:test";

import { MetricsRegistry } from "../metrics.ts";

describe("MetricsRegistry label allow-list", () => {
  it("drops unknown labels and collapses series", () => {
    const reg = new MetricsRegistry();
    reg.registerCounter({
      name: "scoped_total",
      help: "scoped",
      labels: ["status"],
    });

    // Three writes with the same allow-listed label but different
    // rogue labels. They must all collapse onto one series.
    reg.inc("scoped_total", { status: "ok", request_id: "a" });
    reg.inc("scoped_total", { status: "ok", request_id: "b" });
    reg.inc("scoped_total", { status: "ok", request_id: "c" });

    const snapshot = reg.snapshot();
    const entry = snapshot.find((s) => s.name === "scoped_total");
    expect(entry).toBeDefined();
    expect(entry?.samples.length).toBe(1);
    expect(entry?.samples[0]?.value).toBe(3);
    expect(entry?.samples[0]?.labels).toEqual({ status: "ok" });
  });

  it("fills missing allow-listed labels with empty string", () => {
    const reg = new MetricsRegistry();
    reg.registerCounter({
      name: "execution_total",
      help: "exec",
      labels: ["tenant_id", "status", "workflow_id"],
    });

    reg.inc("execution_total", { tenant_id: "t1" });
    reg.inc("execution_total", { tenant_id: "t1" });

    const snapshot = reg.snapshot();
    const entry = snapshot.find((s) => s.name === "execution_total");
    expect(entry?.samples.length).toBe(1);
    expect(entry?.samples[0]?.value).toBe(2);
    expect(entry?.samples[0]?.labels).toEqual({
      status: "",
      tenant_id: "t1",
      workflow_id: "",
    });
  });
});
