// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// reference-validator — authoring-time pre-flight that refuses a
// workflow whose JSONata / placeholder references point at unknown
// step ids. Pure-function tests; no DB.

import { describe, expect, test } from "bun:test";
import { validateStepReferences } from "../reference-validator.ts";
import type { WorkflowDef } from "../types.ts";

function wf(steps: WorkflowDef["steps"]): WorkflowDef {
  return { name: "t", steps };
}

describe("validateStepReferences", () => {
  test("clean draft returns []", () => {
    const draft = wf([
      {
        id: "a",
        kind: "request",
        method: "GET",
        url: "https://example.com/x",
      },
      {
        id: "b",
        kind: "transform",
        language: "javascript",
        expression: "return { id: input.scope.a.data.id };",
      },
    ]);
    expect(validateStepReferences(draft)).toEqual([]);
  });

  test("flags unknown step in transform.expression", () => {
    const draft = wf([
      { id: "a", kind: "request", method: "GET", url: "https://example.com/x" },
      {
        id: "b",
        kind: "transform",
        language: "javascript",
        expression: "return { id: input.scope.wrong_step.data.id };",
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("wrong_step");
    expect(errors[0]?.field).toBe("expression");
  });

  test("flags unknown step in loop.over", () => {
    const draft = wf([
      { id: "fetch_projects", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "iter",
        kind: "loop",
        over: "$scope.fetch_projets.data.items",
        body: ["fetch_projects"],
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("fetch_projets");
    expect(errors[0]?.field).toBe("over");
    expect(errors[0]?.did_you_mean).toContain("fetch_projects");
  });

  test("flags unknown step in branch.when", () => {
    const draft = wf([
      { id: "approval", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "gate",
        kind: "branch",
        when: "$scope.aproval.outcome = 'approved'",
        then_steps: [],
        else_steps: [],
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("aproval");
    expect(errors[0]?.field).toBe("when");
    expect(errors[0]?.did_you_mean).toContain("approval");
  });

  test("flags unknown step in placeholder inside HTTP step", () => {
    const draft = wf([
      { id: "fetch", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "second",
        kind: "request",
        method: "POST",
        url: "https://x/${scope.fech.data.id}",
        body: { foo: "bar" },
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors.some((e) => e.bad_reference === "fech")).toBe(true);
  });

  test("returns multiple errors when multiple sites reference unknown step ids", () => {
    const draft = wf([
      { id: "a", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "b",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.aa.data;",
      },
      {
        id: "c",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.bb.data;",
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors.length).toBe(2);
  });
});
