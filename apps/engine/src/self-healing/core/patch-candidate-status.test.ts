import { describe, expect, test } from "bun:test";
import { PATCH_CANDIDATE_TRANSITIONS, patchCandidateSources } from "./patch-candidate-status.ts";

describe("patch candidate transitions", () => {
  test("only a proposed candidate moves, and only to a decided status", () => {
    expect(PATCH_CANDIDATE_TRANSITIONS.proposed).toEqual([
      "applied",
      "rejected",
      "superseded",
      "inapplicable",
    ]);
    for (const status of ["applied", "rejected", "superseded", "inapplicable"] as const)
      expect(PATCH_CANDIDATE_TRANSITIONS[status]).toEqual([]);
  });

  test("every decided status is reached from proposed alone", () => {
    expect(patchCandidateSources("applied")).toEqual(["proposed"]);
    expect(patchCandidateSources("rejected")).toEqual(["proposed"]);
    expect(patchCandidateSources("inapplicable")).toEqual(["proposed"]);
    expect(patchCandidateSources("superseded")).toEqual(["proposed"]);
  });

  test("nothing returns to proposed", () => {
    expect(patchCandidateSources("proposed")).toEqual([]);
  });
});
