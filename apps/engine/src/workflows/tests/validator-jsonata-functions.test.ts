import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";

const workflow = (when: string) => ({
  name: "branch-call-validation",
  steps: [
    { id: "gate", kind: "branch", when, then_steps: ["done"], else_steps: [] },
    { id: "done", kind: "transform", language: "javascript", expression: "return true;" },
  ],
});

describe("workflow validator · JSONata function calls", () => {
  test("rejects a bare function call before the workflow can be saved", () => {
    const result = validateWorkflowDef(workflow("not(true)"));
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      path: "steps.gate.when",
      message: "JSONata function `not(...)` is not bound; use `$not(...)`",
    });
  });

  test("accepts the runtime-compatible $-prefixed form", () => {
    const result = validateWorkflowDef(workflow("$not(true)"));
    expect(result.ok).toBe(true);
  });
});
