// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// Bare-path validation. The skill documents `<step_id>.data` as
// equivalent to `$scope.<step_id>.data`, so the LLM uses both forms.
// The original validator only caught $scope./$steps./${scope.X}
// references; this pass covers the bare form.

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
        // typo: fetch_projets vs. fetch_projects, no $scope prefix
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
        // `input` is a JSONata binding, not a step id
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
        // unknown_step appears twice — once explicit, once bare
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
        // `r` is a JSONata lambda arg; threshold is length >= 3
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
