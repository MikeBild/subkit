// Unit tests for the ONE confirm-gate decision (`decideConfirm`).
//
// This is the single deterministic rule every pre-execution gate
// evaluates. The security-critical invariant: a write NEVER proceeds
// without a `policyMarker` OR a durable `priorApproval`.

import { describe, expect, test } from "bun:test";
import { decideConfirm } from "./confirm-decision.ts";

describe("decideConfirm — reads auto-run", () => {
  test("tenant_read never pauses, regardless of mode", () => {
    for (const resolvedMode of [
      "no_confirm",
      "confirm_before_execution",
      "confirm_after_execution",
    ] as const) {
      const decision = decideConfirm({
        resolvedMode,
        policyMarker: false,
        priorApproval: false,
        category: "tenant_read",
      });
      expect(decision.pause).toBe(false);
      expect(decision.reason).toBe("tenant_read_autoruns");
    }
  });
});

describe("decideConfirm — non-confirm modes never pre-pause", () => {
  test("no_confirm write proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "no_confirm",
      policyMarker: false,
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });

  test("confirm_after_execution does not PRE-pause (post-exec review is downstream)", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_after_execution",
      policyMarker: false,
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });
});

describe("decideConfirm — writes under confirm_before_execution", () => {
  test("write WITHOUT approval or marker PAUSES", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      policyMarker: false,
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("write WITH policyMarker proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      policyMarker: true,
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("policy_marker_present");
  });

  test("write WITH durable priorApproval proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      policyMarker: false,
      priorApproval: true,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("prior_approval_present");
  });

  test("draft_write (save path) WITHOUT approval PAUSES — same rule as tenant_write", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      policyMarker: false,
      priorApproval: false,
      category: "draft_write",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("policyMarker wins over a missing approval (marker checked first)", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      policyMarker: true,
      priorApproval: false,
      category: "draft_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("policy_marker_present");
  });
});

describe("decideConfirm — bias to pause on ambiguity", () => {
  // The security property, stated exhaustively: across every input
  // combination, a write proceeds IFF policyMarker OR priorApproval,
  // and only under confirm_before_execution + a non-read category.
  test("no write proceeds under confirm_before_execution without marker OR approval", () => {
    for (const category of ["tenant_write", "draft_write"] as const) {
      for (const policyMarker of [false, true]) {
        for (const priorApproval of [false, true]) {
          const decision = decideConfirm({
            resolvedMode: "confirm_before_execution",
            policyMarker,
            priorApproval,
            category,
          });
          const authorized = policyMarker || priorApproval;
          expect(decision.pause).toBe(!authorized);
        }
      }
    }
  });
});
