import { describe, expect, test } from "bun:test";
import { filterBySkillGate, requiredSkillFor, SKILL_GATED_TOOLS } from "../gated.ts";

describe("skill gate — static baseline", () => {
  test("approve_patch_candidate is gated by self-healing", () => {
    expect(requiredSkillFor("approve_patch_candidate")).toBe("self-healing");
  });

  test("non-gated tools return undefined", () => {
    expect(requiredSkillFor("list_connectors")).toBeUndefined();
  });

  test("SKILL_GATED_TOOLS constant is not empty", () => {
    expect(Object.keys(SKILL_GATED_TOOLS).length).toBeGreaterThan(0);
  });

  test("filterBySkillGate — gated tool hidden without skill, visible with", () => {
    const tools = [{ name: "list_connectors" }, { name: "approve_patch_candidate" }];
    const hidden = filterBySkillGate(tools, []);
    expect(hidden.map((t) => t.name)).toEqual(["list_connectors"]);
    const visible = filterBySkillGate(tools, ["self-healing"]);
    expect(visible.map((t) => t.name)).toEqual(["list_connectors", "approve_patch_candidate"]);
  });
});
