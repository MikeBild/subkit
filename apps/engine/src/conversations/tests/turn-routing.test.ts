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
    expect(plan.action).toContain("subkit mcp");
  });

  test("routes schedule questions to partial-support guidance", () => {
    const plan = planTurnRouting({
      draft: draft(),
      user_message: "How to run a workflow scheduled?",
    });
    expect(plan.intent).toBe("surface_help");
    expect(plan.action).toContain("scheduled workflow execution");
    expect(plan.action).toContain("not exposed");
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
});
