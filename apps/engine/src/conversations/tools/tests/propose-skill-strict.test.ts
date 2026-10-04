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

  it("toInputExamples is a no-op for any input (regression suppressor)", () => {
    expect(toInputExamples({ scope: "global", title: "x" })).toEqual({});
    expect(toInputExamples(undefined)).toEqual({});
    expect(toInputExamples(proposeSkillTool.example_input)).toEqual({});
  });
});
