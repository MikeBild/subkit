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
