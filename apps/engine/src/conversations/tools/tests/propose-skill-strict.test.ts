// Property tests for the strict / inputExamples opt-in.
//
// `proposeSkillTool` opts into provider-native strict mode because its
// input schema is all concrete types. The authoring tools
// (author_workflow, edit_workflow_patch) keep strict OFF because their
// schemas carry `z.unknown()` slots (a free-form input example, JSON
// Patch values) which strict mode does not accept — asserted here so a
// future refactor that flips strict on those tools without also
// tightening the schema fails fast.

import { describe, expect, it } from "bun:test";

import { authorWorkflowTool } from "../author-workflow.ts";
import { editWorkflowPatchTool } from "../edit-workflow-patch.ts";
import { proposeSkillTool } from "../propose-skill.ts";
import { toInputExamples } from "../sdk-wrap/invoke.ts";

describe("strict + inputExamples opt-in", () => {
  it("propose_skill opts into strict mode", () => {
    expect(proposeSkillTool.strict).toBe(true);
  });

  it("propose_skill ships an example_input", () => {
    expect(proposeSkillTool.example_input).toBeDefined();
    expect(typeof proposeSkillTool.example_input).toBe("object");
    expect((proposeSkillTool.example_input as Record<string, unknown>).scope).toBe("global");
  });

  it("propose_skill example_input parses against its inputSchema", () => {
    const parsed = proposeSkillTool.inputSchema.safeParse(proposeSkillTool.example_input);
    expect(parsed.success).toBe(true);
  });

  it("author_workflow keeps strict off (carries a free-form input_example)", () => {
    expect(authorWorkflowTool.strict).toBeUndefined();
  });

  it("edit_workflow_patch keeps strict off (JSON Patch values are unknown)", () => {
    expect(editWorkflowPatchTool.strict).toBeUndefined();
  });

  // Regression in v4.6.0: AI SDK 6 strict-validates `inputExamples`
  // against the JSON-Schema projection of `inputSchema`. The projection
  // unconditionally seals every object with `additionalProperties:
  // false` — including `z.record(...)` values, which legitimately
  // accept any string key. The mismatch made Anthropic reject every
  // conversation turn with `tools.N.custom: Example at index 0 is
  // invalid: False schema does not allow <value>`. The fix is to stop
  // emitting the `inputExamples` channel; the model still sees the
  // example via the `<example>` block compileDescription appends to
  // the tool description. The tests below pin the current contract:
  // `toInputExamples` is a no-op until upstream record projection is
  // fixed AND every tool's example survives the strict JSON-Schema
  // validation.
  it("toInputExamples is a no-op for any input (regression suppressor)", () => {
    expect(toInputExamples({ scope: "global", title: "x" })).toEqual({});
    expect(toInputExamples(undefined)).toEqual({});
    expect(toInputExamples(proposeSkillTool.example_input)).toEqual({});
  });
});
