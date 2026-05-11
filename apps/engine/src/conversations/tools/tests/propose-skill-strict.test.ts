// Property tests for the strict / inputExamples opt-in (issue #165).
//
// `proposeSkillTool` opts into provider-native strict mode because its
// input schema is all concrete types. The two sibling authoring tools
// (build_workflow, propose_step) keep strict OFF because their schemas
// include `z.record(z.unknown())` which strict mode does not accept —
// asserted here so a future refactor that flips strict on those tools
// without also tightening the schema fails fast.

import { describe, expect, it } from "bun:test";
import { buildWorkflowTool } from "../build-workflow.ts";
import { proposeSkillTool } from "../propose-skill.ts";
import { proposeStepTool } from "../propose-step.ts";

describe("issue #165 — strict + inputExamples opt-in", () => {
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

  it("build_workflow keeps strict off (uses z.record(z.unknown()))", () => {
    expect(buildWorkflowTool.strict).toBeUndefined();
  });

  it("propose_step keeps strict off (uses z.record(z.unknown()))", () => {
    expect(proposeStepTool.strict).toBeUndefined();
  });
});
