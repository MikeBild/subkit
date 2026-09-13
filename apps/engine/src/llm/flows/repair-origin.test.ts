// What the repair flow says about its own origin, and what it hands the
// accountant.
//
// Both used to come from a single required `execution_id: string`. The
// proactive caller had no execution and filled the field with
// `ctx.scan_id ?? "proactive"` (self-healing/service.ts), so:
//
//   - a `self_healing_scans.id` — a well-formed uuid — was written into
//     `llm_usage.execution_id`, where it looked like an execution reference
//     and joined to nothing. 163 rows, 2026-06-26 to 2026-08-19.
//   - "proactive" is not a uuid, so that INSERT raised inside the
//     best-effort accounting catch and the billing row was lost entirely.
//   - the prompt told the model "Execution: <scan uuid>".
//
// These pin the field staying empty when there is nothing honest to put in
// it. The uuid guard in the accountant and the foreign key in migration 0040
// are the other two layers; this is the one that stops the wrong value at
// the source.

import { describe, expect, it } from "bun:test";

import { repairOrigin, repairTelemetry } from "./repair.ts";

const SCAN = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
const EXEC = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const STEP = { id: "proactive:connector_drift:stripe" };

describe("repairOrigin", () => {
  it("names the execution when there is one", () => {
    expect(repairOrigin({ execution_id: EXEC, scan_id: SCAN })).toBe(`Execution: ${EXEC}`);
  });

  it("names the scan as a scan — never as an execution", () => {
    const line = repairOrigin({ execution_id: null, scan_id: SCAN });
    expect(line).toBe(`Proactive scan: ${SCAN} (no execution)`);
    expect(line.startsWith("Execution:")).toBe(false);
  });

  it("says there is no execution when there is neither", () => {
    expect(repairOrigin({ execution_id: null })).toBe("Proactive repair (no execution)");
  });
});

describe("repairTelemetry", () => {
  it("omits execution_id entirely when there is no execution", () => {
    const t = repairTelemetry({ execution_id: null, scan_id: SCAN, failing_step: STEP }, 1);
    // Absent, not null and not the scan id: the accountant only copies the
    // key when it is present, and `llm_usage.execution_id` must stay NULL.
    expect("execution_id" in t).toBe(false);
    expect(t.execution_id).not.toBe(SCAN);
  });

  it("carries the scan under its own key, not the execution's", () => {
    const t = repairTelemetry({ execution_id: null, scan_id: SCAN, failing_step: STEP }, 1);
    expect(t.scan_id).toBe(SCAN);
    expect(t.execution_id).toBeUndefined();
  });

  it("carries the execution when there is one", () => {
    const t = repairTelemetry({ execution_id: EXEC, scan_id: SCAN, failing_step: STEP }, 2);
    expect(t.execution_id).toBe(EXEC);
    expect(t.scan_id).toBe(SCAN);
    expect(t.attempt).toBe(2);
    expect(t.failing_step).toBe(STEP.id);
  });

  it("never emits the literal that used to destroy the row", () => {
    for (const p of [
      { execution_id: null, failing_step: STEP },
      { execution_id: null, scan_id: SCAN, failing_step: STEP },
      { execution_id: EXEC, failing_step: STEP },
    ]) {
      expect(Object.values(repairTelemetry(p, 1))).not.toContain("proactive");
    }
  });
});
