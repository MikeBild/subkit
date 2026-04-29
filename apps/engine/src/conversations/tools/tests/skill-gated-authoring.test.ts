// Bug OO regression: build_workflow / propose_step / update_param /
// inspect_workflow are gated on the `workflow-authoring` skill being
// loaded. Mirrors reference impl's SKILL_LOADING_INSTRUCTIONS — the
// model cannot author a workflow without first reading the contract.

import { describe, expect, test } from "bun:test";
import { filterBySkillGate, SKILL_GATED_TOOLS } from "../gated.ts";

describe("skill-gated tool exposure (Bug OO)", () => {
  test("build_workflow requires workflow-authoring", () => {
    expect(SKILL_GATED_TOOLS.build_workflow).toBe("workflow-authoring");
  });

  test("propose_step requires workflow-authoring", () => {
    expect(SKILL_GATED_TOOLS.propose_step).toBe("workflow-authoring");
  });

  test("update_param requires workflow-authoring", () => {
    expect(SKILL_GATED_TOOLS.update_param).toBe("workflow-authoring");
  });

  test("inspect_workflow requires workflow-authoring", () => {
    expect(SKILL_GATED_TOOLS.inspect_workflow).toBe("workflow-authoring");
  });

  test("connector authoring tools require connector-creation-guidance", () => {
    expect(SKILL_GATED_TOOLS.start_connector_from_description).toBe("connector-creation-guidance");
    expect(SKILL_GATED_TOOLS.start_connector_from_template).toBe("connector-creation-guidance");
    expect(SKILL_GATED_TOOLS.update_connector_draft).toBe("connector-creation-guidance");
  });

  test("filterBySkillGate hides build_workflow until workflow-authoring is loaded", () => {
    const tools = [
      { name: "build_workflow" },
      { name: "list_connectors" },
      { name: "propose_step" },
    ];
    const visibleEmpty = filterBySkillGate(tools, []);
    expect(visibleEmpty.map((t) => t.name)).toEqual(["list_connectors"]);

    const visibleAfterLoad = filterBySkillGate(tools, ["workflow-authoring"]);
    expect(visibleAfterLoad.map((t) => t.name).sort()).toEqual(
      ["build_workflow", "list_connectors", "propose_step"].sort(),
    );
  });

  test("filterBySkillGate hides inspect_workflow until workflow-authoring is loaded", () => {
    const tools = [{ name: "inspect_workflow" }, { name: "inspect_execution_step" }];
    expect(filterBySkillGate(tools, []).map((t) => t.name)).toEqual(["inspect_execution_step"]);
    expect(
      filterBySkillGate(tools, ["workflow-authoring"])
        .map((t) => t.name)
        .sort(),
    ).toEqual(["inspect_execution_step", "inspect_workflow"]);
  });

  test("self-healing gate (approve_patch_candidate) is preserved unchanged", () => {
    expect(SKILL_GATED_TOOLS.approve_patch_candidate).toBe("self-healing");
  });
});
