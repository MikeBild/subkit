import { describe, expect, test } from "bun:test";
import { validateStepReferences } from "../reference-validator.ts";
import type { WorkflowDef } from "../types.ts";

function wf(steps: WorkflowDef["steps"], extra: Partial<WorkflowDef> = {}): WorkflowDef {
  return { name: "t", steps, ...extra };
}

describe("validateStepReferences · bare-path forms", () => {
  test("flags a bare-path reference to an unknown step id", () => {
    const draft = wf([
      { id: "fetch_projects", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "shape",
        kind: "transform",
        expression: "fetch_projets.data.id",
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("fetch_projets");
    expect(errors[0]?.did_you_mean).toContain("fetch_projects");
  });

  test("ignores reserved built-ins", () => {
    const draft = wf([
      {
        id: "shape",
        kind: "transform",
        expression: "input.user.email",
      },
    ]);
    expect(validateStepReferences(draft)).toEqual([]);
  });

  test("ignores known step ids referenced via the bare form", () => {
    const draft = wf([
      { id: "fetch", kind: "request", method: "GET", url: "https://x/y" },
      {
        id: "shape",
        kind: "transform",
        expression: "fetch.data.id",
      },
    ]);
    expect(validateStepReferences(draft)).toEqual([]);
  });

  test("does not double-flag when both $scope and bare match", () => {
    const draft = wf([
      {
        id: "shape",
        kind: "transform",
        expression: "$scope.unknown_step.id + unknown_step.id",
      },
    ]);
    const errors = validateStepReferences(draft);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("unknown_step");
  });

  test("skips short identifiers that look like local vars", () => {
    const draft = wf([
      {
        id: "shape",
        kind: "transform",
        expression: "$map(items, function($r){ $r.id })",
      },
    ]);
    expect(validateStepReferences(draft)).toEqual([]);
  });
});

describe("validateStepReferences · output_transform", () => {
  test("flags unknown ref in output_transform", () => {
    const draft = wf([{ id: "fetch", kind: "request", method: "GET", url: "https://x/y" }], {
      output_transform: "$scope.feetch.data",
    } as Partial<WorkflowDef>);
    const errors = validateStepReferences(draft);
    expect(errors[0]?.step_id).toBe("(output_transform)");
    expect(errors[0]?.bad_reference).toBe("feetch");
  });

  test("flags unknown ref in output_transform_function", () => {
    const draft = wf([{ id: "fetch", kind: "request", method: "GET", url: "https://x/y" }], {
      output_transform_function: "(scope) => scope.feetch.data",
      // biome-ignore lint/suspicious/noExplicitAny: schema field exists on draft documents
    } as any);
    const errors = validateStepReferences(draft);
    expect(errors.some((e) => e.step_id === "(output_transform_function)")).toBe(true);
  });
});
