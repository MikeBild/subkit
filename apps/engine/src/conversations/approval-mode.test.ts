// Bug SS regression: getApprovalMode + APPROVAL_LABELS power the
// discoverable `/policy` panel (mirrors reference impl's
// AgentCapabilities). The test pins:
//   - every dangerous tool reports "approval_before"
//   - read-only tools report "auto"
//   - confirm_after_execution tools report "approval_after"
//   - tools with computeModeFromInput are over-promised as "approval_before"

import { describe, expect, test } from "bun:test";
import { APPROVAL_LABELS, getApprovalMode } from "./tool-policies.ts";

describe("getApprovalMode (Bug SS)", () => {
  test("APPROVAL_LABELS covers all three approval modes", () => {
    expect(APPROVAL_LABELS.auto).toBe("Runs automatically");
    expect(APPROVAL_LABELS.approval_before).toBe("Asks before running");
    expect(APPROVAL_LABELS.approval_after).toBe("Review after run");
  });

  test("destructive tools are approval_before", () => {
    expect(getApprovalMode("delete_workflow")).toBe("approval_before");
    expect(getApprovalMode("delete_connector")).toBe("approval_before");
    expect(getApprovalMode("revoke_api_key")).toBe("approval_before");
    expect(getApprovalMode("approve_patch_candidate")).toBe("approval_before");
  });

  test("authenticate_oauth is approval_after (Bug UU wiring)", () => {
    expect(getApprovalMode("authenticate_oauth")).toBe("approval_after");
  });

  test("tools with computeModeFromInput are over-promised as approval_before", () => {
    // run_workflow has a dynamic mode (env-dependent); the badge
    // promises the worst-case behaviour ("Asks before running") so
    // the operator never sees a tool surprise-run.
    expect(getApprovalMode("run_workflow")).toBe("approval_before");
    expect(getApprovalMode("probe_connector")).toBe("approval_before");
  });

  test("unknown tool reports auto (permissive default)", () => {
    expect(getApprovalMode("does_not_exist")).toBe("auto");
  });
});
