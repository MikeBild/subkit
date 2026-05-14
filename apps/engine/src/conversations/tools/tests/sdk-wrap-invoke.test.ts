// Targeted tests for the concrete-alternatives generator used by the
// consecutive-failures cap (Adoption D). The helper itself lives in
// `sdk-wrap/error-recovery-hints.ts`; this file also asserts that the
// catalogue stays in sync with the error codes any tool actually
// surfaces.

import { describe, expect, it } from "bun:test";
import { buildCapAlternatives, ERROR_CODE_ALTERNATIVES } from "../sdk-wrap/error-recovery-hints.ts";

describe("buildCapAlternatives", () => {
  it("returns empty string when no failures are recorded", () => {
    expect(buildCapAlternatives(new Map())).toBe("");
  });

  it("returns empty string when the recorded error codes are unknown", () => {
    const errors = new Map([["propose_step", "some_unknown_code|boom"]]);
    expect(buildCapAlternatives(errors)).toBe("");
  });

  it("emits the concrete recovery hint for transform_authoring_requires_inspect", () => {
    const errors = new Map([
      ["update_param", "transform_authoring_requires_inspect|must inspect first"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out).toContain("transform_authoring_requires_inspect");
    expect(out).toContain("inspect_execution_step");
  });

  it("dedupes by error code when multiple tools share the same code", () => {
    const errors = new Map([
      ["propose_step", "step_invalid|foo"],
      ["update_param", "step_invalid|bar"],
    ]);
    const out = buildCapAlternatives(errors);
    // Only one bullet for the single unique error code.
    expect(out.match(/step_invalid/g)?.length).toBe(1);
  });

  it("renders multiple distinct codes as separate bullets", () => {
    const errors = new Map([
      ["transform_authoring", "transform_authoring_requires_inspect|hint"],
      ["request_step", "http_4xx|hint"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out).toContain("transform_authoring_requires_inspect");
    expect(out).toContain("http_4xx");
    // Two distinct bullet points.
    expect(out.match(/^ {2}•/gm)?.length).toBe(2);
  });

  it("never trips on a malformed shape string (no '|' separator)", () => {
    const errors = new Map([["propose_step", "raw_string_no_pipe"]]);
    // Whatever happens, the function must not throw and must return a string.
    expect(typeof buildCapAlternatives(errors)).toBe("string");
  });
});

describe("ERROR_CODE_ALTERNATIVES catalogue", () => {
  // Per the review (S4): the test should assert the catalogue stays
  // complete relative to the error codes any tool can surface. These
  // are the codes the engine emits today from `ok: false` branches —
  // adding a new code without an entry here is a silent regression
  // because the cap message falls back to the generic "ask the user".
  const REGISTERED_ERROR_CODES = [
    "transform_authoring_requires_inspect",
    "step_update_invalid",
    "step_invalid",
    "unknown_step",
    "unresolved_identifier",
    "http_4xx",
    "execution_not_found",
    "verifier_rejected",
    "repair_loop_detected",
  ] as const;

  it("has an entry for every registered error code", () => {
    for (const code of REGISTERED_ERROR_CODES) {
      expect(ERROR_CODE_ALTERNATIVES[code]).toBeDefined();
      expect(typeof ERROR_CODE_ALTERNATIVES[code]).toBe("string");
      expect((ERROR_CODE_ALTERNATIVES[code] ?? "").length).toBeGreaterThan(20);
    }
  });
});
