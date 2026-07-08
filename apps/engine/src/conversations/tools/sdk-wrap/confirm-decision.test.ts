// Unit tests for the ONE confirm-gate decision (`decideConfirm`).
//
// This is the single deterministic rule every pre-execution gate
// evaluates. The security-critical invariant: a write NEVER proceeds
// without a durable `priorApproval`, and there is NO model-suppliable
// input that could stand in for one.

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
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });

  test("confirm_after_execution does not PRE-pause (post-exec review is downstream)", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_after_execution",
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("mode_not_confirm_before_execution");
  });
});

describe("decideConfirm — writes under confirm_before_execution", () => {
  test("write WITHOUT a durable approval PAUSES", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });

  test("write WITH durable priorApproval proceeds", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: true,
      category: "tenant_write",
    });
    expect(decision.pause).toBe(false);
    expect(decision.reason).toBe("prior_approval_present");
  });

  test("draft_write (save path) WITHOUT approval PAUSES — same rule as tenant_write", () => {
    const decision = decideConfirm({
      resolvedMode: "confirm_before_execution",
      priorApproval: false,
      category: "draft_write",
    });
    expect(decision.pause).toBe(true);
    expect(decision.reason).toBe("confirm_required");
  });
});

describe("decideConfirm — bias to pause on ambiguity", () => {
  // The security property, stated exhaustively: across every input
  // combination, a write proceeds IFF a durable priorApproval exists,
  // and only under confirm_before_execution + a non-read category.
  test("no write proceeds under confirm_before_execution without a durable approval", () => {
    for (const category of ["tenant_write", "draft_write"] as const) {
      for (const priorApproval of [false, true]) {
        const decision = decideConfirm({
          resolvedMode: "confirm_before_execution",
          priorApproval,
          category,
        });
        expect(decision.pause).toBe(!priorApproval);
      }
    }
  });
});
