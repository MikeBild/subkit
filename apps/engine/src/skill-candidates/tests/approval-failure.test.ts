import { describe, expect, test } from "bun:test";
import { approvalFailureOf } from "../service.ts";

describe("why a skill candidate approval did not happen", () => {
  test("a missing candidate, a drafting-context note or a collected learning is not found", () => {
    expect(approvalFailureOf(null)).toBe("not_found");
    expect(approvalFailureOf({ status: "context", pattern_kind: "authoring_capability" })).toBe(
      "not_found",
    );
    expect(approvalFailureOf({ status: "proposed", pattern_kind: "session_learning" })).toBe(
      "not_found",
    );
  });

  test("a candidate still proposed changed since its review", () => {
    expect(approvalFailureOf({ status: "proposed", pattern_kind: "success_pattern" })).toBe(
      "changed_since_review",
    );
  });

  test("a candidate no longer proposed was already decided", () => {
    for (const status of ["approved", "rejected", "superseded"] as const)
      expect(approvalFailureOf({ status, pattern_kind: "success_pattern" })).toBe(
        "already_decided",
      );
  });
});
