// item_var retirement — validation surfaces.
//
//   - `validateWorkflowDef` is THE enforcement point: any definition
//     declaring `item_var` is rejected on every write surface.
//   - The loop-body-references-item rule accepts the canonical forms
//     only (`$item` in JSONata, `${item.…}` in strings) for new
//     definitions; a legacy definition that declares `item_var` still
//     satisfies the rule with its declared bare name (it is rejected
//     for the declaration itself, but must not double-fire).
//   - `validateBareIterationIdentifiers` lints bare iteration names in
//     loop-body JSONata with a concrete `$item` rewrite as did_you_mean.
//   - The conversations verifier rejects both at build time.

import { describe, expect, test } from "bun:test";
import { verifyWorkflow } from "../../conversations/verifier.ts";
import { validateBareIterationIdentifiers } from "../reference-validator.ts";
import { validateWorkflowDef } from "../validator.ts";

const baseSteps = [
  { id: "get_numbers", kind: "transform", expression: "[1, 2, 3]" },
  { id: "iter", kind: "loop", over: "get_numbers.data", body: ["double"] },
  { id: "double", kind: "transform", expression: "$item * 2" },
];

describe("validateWorkflowDef — item_var rejection (single enforcement point)", () => {
  test("declaring item_var is rejected with a $item rewrite hint", () => {
    const res = validateWorkflowDef({
      name: "legacy",
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

  test("legacy declared contract does not double-fire the loop-body rule", () => {
    const res = validateWorkflowDef({
      name: "legacy",
      steps: [
        baseSteps[0],
        { id: "iter", kind: "loop", over: "get_numbers.data", item_var: "num", body: ["double"] },
        { id: "double", kind: "transform", expression: "num * 2" },
      ],
    });
    // Only the item_var rejection — the bare `num` reference satisfies
    // the declared legacy contract for the body-references-item rule.
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.path).toBe("steps.iter.item_var");
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
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder is the tested grammar.
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
        // bare `num` is unbound for definitions without item_var — the
        // rule must flag the body as never referencing the item.
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
  test("bare `item` in loop-body JSONata → did_you_mean carries the $item rewrite", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", body: ["shape"] },
      { id: "shape", kind: "transform", expression: "item.name" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.step_id).toBe("shape");
    expect(errors[0]?.field).toBe("expression");
    expect(errors[0]?.bad_reference).toBe("item");
    expect(errors[0]?.did_you_mean).toEqual(["$item.name"]);
  });

  test("legacy declared item_var name is linted with the concrete rewrite", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", item_var: "project", body: ["shape"] },
      { id: "shape", kind: "transform", expression: "project.name & ' x'" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.bad_reference).toBe("project");
    expect(errors[0]?.did_you_mean).toEqual(["$item.name & ' x'"]);
  });

  test("canonical $item usage produces no findings", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", body: ["shape"] },
      { id: "shape", kind: "transform", expression: "$item.name" },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("steps outside any loop body are not linted", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "shape", kind: "transform", expression: "item.name" },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("item as a field lookup inside a predicate is not linted", () => {
    const errors = validateBareIterationIdentifiers([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", body: ["shape"] },
      { id: "shape", kind: "transform", expression: "$item.rows[item > 2]" },
    ]);
    expect(errors).toHaveLength(0);
  });
});

describe("conversations verifier — build-time rejection", () => {
  test("item_var declaration is an error finding", () => {
    const report = verifyWorkflow({
      name: "legacy",
      steps: [
        { id: "get", kind: "transform", expression: "[1]" },
        { id: "iter", kind: "loop", over: "get.data", item_var: "num", body: ["double"] },
        { id: "double", kind: "transform", expression: "num * 2" },
      ],
    });
    const codes = report.errors.map((e) => e.code);
    expect(codes).toContain("item_var_retired");
    expect(codes).toContain("bare_iteration_identifier");
    const bare = report.errors.find((e) => e.code === "bare_iteration_identifier");
    expect(bare?.message).toContain("$item * 2");
  });

  test("canonical $item draft verifies clean", () => {
    const report = verifyWorkflow({
      name: "ok",
      steps: [
        { id: "get", kind: "transform", expression: "[1]" },
        { id: "iter", kind: "loop", over: "get.data", body: ["double"] },
        { id: "double", kind: "transform", expression: "$item * 2" },
      ],
    });
    expect(report.errors).toHaveLength(0);
  });
});
