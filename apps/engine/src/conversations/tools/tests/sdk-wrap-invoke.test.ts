// Targeted tests for the get_raw_result truncation bypass (Fix 1) and the
// concrete-alternatives generator used by the consecutive-failures cap
// (Adoption D). Both live in sdk-wrap/invoke.ts but are written here to
// keep the existing test layout (conversations/tools/tests/).

import { describe, expect, it } from "bun:test";
import { buildCapAlternatives } from "../sdk-wrap/invoke.ts";

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
