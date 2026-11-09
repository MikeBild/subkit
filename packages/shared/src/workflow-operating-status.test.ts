import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_OPERATING_STATUSES,
  workflowOperatingStatus,
} from "./workflow-operating-status.ts";
import { workflowStrip } from "./workflow-strip.ts";

describe("workflow operating status", () => {
  test("publishes every user-facing operating status", () => {
    expect(WORKFLOW_OPERATING_STATUSES).toEqual([
      "active",
      "waiting_approval",
      "waiting_connector",
      "failing",
      "stopped",
      "repair_required",
      "unapproved",
      "disabled",
      "unknown",
    ]);
  });

  test("keeps unverifiable and loading states separate from active", () => {
    for (const kind of ["loading", "failed", "unknown"] as const)
      expect(workflowOperatingStatus(kind)).toBe("unknown");
    for (const kind of ["approved", "manual"] as const)
      expect(workflowOperatingStatus(kind)).toBe("active");
  });

  test("uses the detail strip's priority for disabled and deleted connectors", () => {
    const strip = workflowStrip({
      automation: null,
      failed: false,
      disabled: true,
      noSteps: false,
      health: "degraded",
      failedRunId: null,
      repairPrepared: true,
      waitingConnector: { id: "removed", name: "Removed", state: "deleted" },
      rights: { write: false, chat: false },
    });
    expect(strip.kind).toBe("disabled");
    expect(workflowOperatingStatus(strip.kind)).toBe("disabled");
    expect(strip.lower).toEqual(["connector", "failing", "repairPrepared"]);
  });

  test("keeps approval, connector, failure and repair conditions distinct", () => {
    expect(workflowOperatingStatus("apply")).toBe("waiting_approval");
    expect(workflowOperatingStatus("connector")).toBe("waiting_connector");
    expect(workflowOperatingStatus("failing")).toBe("failing");
    expect(workflowOperatingStatus("paused")).toBe("stopped");
    expect(workflowOperatingStatus("repairPrepared")).toBe("repair_required");
    expect(workflowOperatingStatus("invalid")).toBe("repair_required");
    expect(workflowOperatingStatus("unapproved")).toBe("unapproved");
    expect(workflowOperatingStatus("empty")).toBe("unapproved");
  });
});

test("all preparation and paused aliases map to the user-facing status", () => {
  expect(workflowOperatingStatus("grant")).toBe("waiting_approval");
  expect(workflowOperatingStatus("expiring")).toBe("waiting_approval");
  expect(workflowOperatingStatus("stopped")).toBe("stopped");
  expect(workflowOperatingStatus("repair")).toBe("repair_required");
});
