import { describe, expect, test } from "bun:test";
import { planTurnRouting } from "../turn-routing.ts";
import type { DraftDocument } from "../types.ts";

function draft(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    workflow: { name: "new-workflow", steps: [] },
    ...overrides,
  } as DraftDocument;
}

describe("planTurnRouting", () => {
  test("routes workflow deletion to the explicit cleanup tool", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "delete new-workflow",
    });
    expect(plan.intent).toBe("tenant_write");
    expect(plan.required_grounding).toContain("delete_workflow");
    expect(plan.action).toContain("delete_workflow");
  });

  test("routes workflow archiving to unavailable-in-surface guidance", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "archive new-workflow",
    });
    expect(plan.intent).toBe("unsupported_or_unavailable");
    expect(plan.action).toContain("not exposed");
    expect(plan.notes.join(" ")).toContain("Do not claim workflow deletion is unavailable.");
  });

  test("routes MCP questions to surface help with confirmed transports", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "how to use subkit as mcp in claude code?",
    });
    expect(plan.intent).toBe("surface_help");
    expect(plan.action).toContain("/mcp");
    expect(plan.action).toContain("sk mcp");
  });

  test("routes schedule questions to the real schedule tool surface", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "How to run a workflow scheduled?",
    });
    expect(plan.intent).toBe("surface_help");
    expect(plan.action).toContain("create_schedule");
    expect(plan.required_grounding).toContain(
      "apps/engine/src/conversations/tools/generated/writes/schedules.ts",
    );
  });

  test("routes schedule mutations to explicit schedule tools", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "schedule this workflow every hour",
    });
    expect(plan.intent).toBe("tenant_write");
    expect(plan.action).toContain("create_schedule");
    expect(plan.required_grounding).toContain("list_workflows");
  });

  test("routes schedule inspection to list_schedules", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "list schedules",
    });
    expect(plan.intent).toBe("tenant_read");
    expect(plan.action).toContain("list_schedules");
  });

  test("stays in workflow authoring when the draft is already in progress", () => {
    const plan = planTurnRouting({
      draft: draft({ mode: "workflow_authoring" }),
      user_message: "continue",
    });
    expect(plan.intent).toBe("author_workflow");
    expect(plan.required_grounding).toContain("inspect_workflow_draft");
  });

  test("routes generic capability questions to tenant-grounded guidance", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "what can i do?",
    });
    expect(plan.intent).toBe("surface_help");
    expect(plan.required_grounding).toContain("get_engine_status");
    expect(plan.notes.join(" ")).toContain("actual tenant state");
  });

  test("routes self-inventory (skills) to catalog-grounded enumeration", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "which skills do you have?",
    });
    expect(plan.intent).toBe("tenant_read");
    expect(plan.required_grounding).toContain("list_skills");
    expect(plan.required_grounding).toContain("list_knowledge_sources");
    expect(plan.notes.join(" ")).toContain("Never invent");
  });

  test("routes self-inventory (knowledge sources) to catalog-grounded enumeration", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "what knowledge sources are built-in?",
    });
    expect(plan.intent).toBe("tenant_read");
    expect(plan.required_grounding).toContain("list_knowledge_sources");
  });

  test("does NOT hijack a concept question into inventory enumeration", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "what is a skill?",
    });
    // "what is a skill" is a concept question → product_help + SK_CONCEPT_GROUNDING,
    // NOT a tenant_read enumeration of the skill catalog.
    expect(plan.intent).not.toBe("tenant_read");
  });

  test("routes a failing-run question to execution-grounded diagnosis", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "why did my last run fail?",
    });
    expect(plan.intent).toBe("tenant_read");
    expect(plan.required_grounding).toContain("inspect_execution");
    expect(plan.notes.join(" ")).toContain("Do not speculate");
  });
});
