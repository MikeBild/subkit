import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../core/validator.ts";
import { validateBareIterationIdentifiers } from "../reference-validator.ts";
import { executableDefinition, readStoredDefinition } from "../stored-definition.ts";

const baseSteps = [
  { id: "get_numbers", kind: "transform", expression: "[1, 2, 3]" },
  { id: "iter", kind: "loop", over: "get_numbers.data", body: ["double"] },
  { id: "double", kind: "transform", expression: "$item * 2" },
];

describe("validateWorkflowDef — item_var rejection", () => {
  test("declaring item_var is rejected with a $item rewrite hint", () => {
    const res = validateWorkflowDef({
      name: "declares-item-var",
      steps: [
        baseSteps[0],
        { id: "iter", kind: "loop", over: "get_numbers.data", item_var: "num", body: ["double"] },
        { id: "double", kind: "transform", expression: "num * 2" },
      ],
    });
    expect(res.ok).toBe(false);
    const itemVarError = res.errors.find((e) => e.path === "steps.iter.item_var");
    expect(itemVarError).toBeDefined();
    expect(itemVarError?.message).toContain("$item");
    expect(itemVarError?.message).toContain("retired");
  });

  test("a declared item_var name does not satisfy the loop-body rule", () => {
    const res = validateWorkflowDef({
      name: "declares-item-var",
      steps: [
        baseSteps[0],
        { id: "iter", kind: "loop", over: "get_numbers.data", item_var: "num", body: ["double"] },
        { id: "double", kind: "transform", expression: "num * 2" },
      ],
    });
    expect(res.errors.map((e) => e.path).sort()).toEqual(["steps.iter", "steps.iter.item_var"]);
  });

  test("item_var is reported even when the definition fails the schema", () => {
    const res = validateWorkflowDef({
      name: "declares-item-var",
      steps: [
        { id: "iter", kind: "loop", item_var: "num", body: ["double"] },
        { id: "double", kind: "transform", expression: "$item * 2" },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === "steps.iter.item_var")).toBe(true);
  });

  test("canonical $item JSONata reference satisfies the loop-body rule", () => {
    const res = validateWorkflowDef({ name: "ok", steps: baseSteps });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("canonical item string placeholder satisfies the loop-body rule", () => {
    const res = validateWorkflowDef({
      name: "ok",
      steps: [
        { id: "get", kind: "transform", expression: "[{ 'id': 'a' }]" },
        { id: "iter", kind: "loop", over: "get.data", body: ["call"] },
        {
          id: "call",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/x/${item.id}",
        },
      ],
    });
    expect(res.ok).toBe(true);
  });

  test("a bare iteration name no longer satisfies the loop-body rule", () => {
    const res = validateWorkflowDef({
      name: "bare",
      steps: [
        baseSteps[0],
        { id: "iter", kind: "loop", over: "get_numbers.data", body: ["double"] },
        { id: "double", kind: "transform", expression: "num * 2" },
      ],
    });
    expect(res.ok).toBe(false);
    const bodyError = res.errors.find((e) => e.path === "steps.iter");
    expect(bodyError).toBeDefined();
    expect(bodyError?.message).toContain("$item.field");
  });

  test("bare `item` (the retired default) no longer satisfies the loop-body rule", () => {
    const res = validateWorkflowDef({
      name: "bare-default",
      steps: [
        baseSteps[0],
        { id: "iter", kind: "loop", over: "get_numbers.data", body: ["double"] },
        { id: "double", kind: "transform", expression: "item * 2" },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === "steps.iter")).toBe(true);
  });
});

describe("validateBareIterationIdentifiers — authoring lint", () => {
  test("bare `item` in loop-body branch.when → did_you_mean carries the $item rewrite", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", language: "javascript", expression: "return [1];" },
      { id: "iter", kind: "loop", over: "get.data", body: ["gate"] },
      { id: "gate", kind: "branch", when: "item.name", then_steps: [], else_steps: [] },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.step_id).toBe("gate");
    expect(errors[0]?.field).toBe("when");
    expect(errors[0]?.bad_reference).toBe("item");
    expect(errors[0]?.did_you_mean).toEqual(["$item.name"]);
  });

  test("a JavaScript transform in a loop body is NOT bare-item-linted", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", language: "javascript", expression: "return [1];" },
      { id: "iter", kind: "loop", over: "get.data", body: ["shape"] },
      {
        id: "shape",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$item.name;",
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("canonical $item branch.when produces no findings", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", language: "javascript", expression: "return [1];" },
      { id: "iter", kind: "loop", over: "get.data", body: ["gate"] },
      { id: "gate", kind: "branch", when: "$item.name", then_steps: [], else_steps: [] },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("steps outside any loop body are not linted", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "gate", kind: "branch", when: "item.name", then_steps: [], else_steps: [] },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("item as a field lookup inside a predicate is not linted", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", language: "javascript", expression: "return [1];" },
      { id: "iter", kind: "loop", over: "get.data", body: ["gate"] },
      { id: "gate", kind: "branch", when: "$item.rows[item > 2]", then_steps: [], else_steps: [] },
    ]);
    expect(errors).toHaveLength(0);
  });
});

describe("stored definitions — item_var", () => {
  const stored = {
    name: "stored",
    steps: [
      { id: "get", kind: "transform", language: "javascript", expression: "return [1];" },
      { id: "iter", kind: "loop", over: "get.data", item_var: "num", body: ["shape"] },
      { id: "shape", kind: "transform", language: "javascript", expression: "return 1;" },
    ],
  };

  test("a stored version declaring item_var reads as invalid, naming the step", () => {
    const read = readStoredDefinition(stored);
    expect(read.invalid).toBe(true);
    if (!read.invalid) return;
    expect(read.issues).toEqual([
      expect.objectContaining({ path: "steps.1.item_var", step_id: "iter" }),
    ]);
  });

  test("a stored version declaring item_var is refused for execution", () => {
    expect(() => executableDefinition(stored)).toThrow(
      expect.objectContaining({ code: "workflow_version_invalid" }),
    );
  });
});
