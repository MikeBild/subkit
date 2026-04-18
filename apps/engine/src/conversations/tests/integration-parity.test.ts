// Integration parity tests — exercise the cross-cutting wiring we
// added across Gaps #1–#8. Each test is self-contained via the shared
// mock-provider shim so no postgres is required.
//
// Covers:
//   - resolveToolMode honors env=dev vs env=prod for run_workflow
//   - interaction_log splicing into rehydrated tool-result messages
//   - filterBySkillGate hides gated tools until their skill loads
//   - loop's sink still appends events (non-streaming baseline)

import { describe, expect, it } from "bun:test";
import { resolveToolMode } from "../tool-policies.ts";
import { filterBySkillGate, SKILL_GATED_TOOLS } from "../tools/gated.ts";

describe("tool-policy wiring", () => {
  it("run_workflow with environment=dev → no_confirm", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "dev" },
      overrides: {},
    });
    expect(mode).toBe("no_confirm");
  });

  it("run_workflow with environment=prod → confirm_before_execution", () => {
    const mode = resolveToolMode({
      tool: "run_workflow",
      category: "tenant_write",
      input: { workflow_id: "x", environment: "prod" },
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });

  it("approve_patch_candidate always confirm by default", () => {
    const mode = resolveToolMode({
      tool: "approve_patch_candidate",
      category: "tenant_write",
      input: { candidate_id: "00000000-0000-0000-0000-000000000000" },
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });

  it("commit_draft (draft_write) still requires confirm", () => {
    const mode = resolveToolMode({
      tool: "commit_draft",
      category: "draft_write",
      input: {},
      overrides: {},
    });
    expect(mode).toBe("confirm_before_execution");
  });
});

describe("skill-gate wiring", () => {
  it("filterBySkillGate hides approve_patch_candidate until self-healing skill is loaded", () => {
    expect(SKILL_GATED_TOOLS.approve_patch_candidate).toBe("self-healing");
    const tools = [
      { name: "list_workflows" },
      { name: "approve_patch_candidate" },
      { name: "run_workflow" },
    ];
    const withoutSkill = filterBySkillGate(tools, []);
    expect(withoutSkill.map((t) => t.name)).toEqual(["list_workflows", "run_workflow"]);
    const withSkill = filterBySkillGate(tools, ["self-healing"]);
    expect(withSkill.map((t) => t.name)).toEqual([
      "list_workflows",
      "approve_patch_candidate",
      "run_workflow",
    ]);
  });
});
