// Golden test matrix for the item_var → $item AST rewriter.
//
// Every rewrite must carry the structural equivalence proof; every
// hazard must abort with ok:false so the caller leaves the stored
// workflow untouched. Where it sharpens the proof, cases also evaluate
// the original expression against a legacy childScope and the
// rewritten expression against the canonical bindings and assert equal
// results — the runtime-level meaning of "semantics preserving".

import { describe, expect, test } from "bun:test";
import { buildJsonataBindings } from "../../execution/jsonata-bindings.ts";
import { compile as compileJsonata } from "../../execution/jsonata-engine.ts";
import {
  findBareItemRefs,
  rewriteBareItemRefs,
  rewriteWorkflowItemVars,
} from "../itemvar-rewrite.ts";
import type { WorkflowDef } from "../types.ts";
import { WorkflowDefSchema } from "../types.ts";

async function evalWithScope(expression: string, scope: Record<string, unknown>): Promise<unknown> {
  return compileJsonata(expression).evaluate(scope, buildJsonataBindings(scope, null));
}

/** Legacy childScope (declared item_var bound) vs canonical childScope
 *  ($item only) must produce identical results. */
async function assertRuntimeEquivalent(
  original: string,
  rewritten: string,
  name: string,
  item: unknown,
  baseScope: Record<string, unknown> = {},
): Promise<void> {
  const legacyScope = { ...baseScope, [name]: item, $item: item, $loop_index: 0 };
  const canonicalScope = { ...baseScope, $item: item, $loop_index: 0 };
  const before = await evalWithScope(original, legacyScope);
  const after = await evalWithScope(rewritten, canonicalScope);
  expect(after).toEqual(before);
}

describe("rewriteBareItemRefs — single expressions", () => {
  test("bare ref is rewritten: num * 2 → $item * 2", async () => {
    const r = rewriteBareItemRefs("num * 2", "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.rewritten).toBe("$item * 2");
    await assertRuntimeEquivalent("num * 2", r.rewritten, "num", 21);
  });

  test("path tail survives: project.name & ' - ' & project.id", async () => {
    const src = "project.name & ' - ' & project.id";
    const r = rewriteBareItemRefs(src, "project");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rewritten).toBe("$item.name & ' - ' & $item.id");
    await assertRuntimeEquivalent(src, r.rewritten, "project", { name: "Alpha", id: "p1" });
  });

  test("no refs → unchanged", () => {
    const r = rewriteBareItemRefs("$scope.fetch.data.items", "num");
    expect(r).toEqual({ ok: true, changed: false, rewritten: "$scope.fetch.data.items" });
  });

  test("lambda arguments named X are variables, never rewritten", async () => {
    const src = "$map(num.rows, function($num) { $num.x })";
    const r = rewriteBareItemRefs(src, "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the bare path head `num.rows` is the loop binding; the
    // lambda's `$num` argument and its body usage stay untouched.
    expect(r.rewritten).toBe("$map($item.rows, function($num) { $num.x })");
    await assertRuntimeEquivalent(src, r.rewritten, "num", { rows: [{ x: 1 }, { x: 2 }] });
  });

  test("bare ref INSIDE a lambda body is root-context and is rewritten", async () => {
    const src = "$map([1,2], function($v) { num })";
    const r = rewriteBareItemRefs(src, "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rewritten).toBe("$map([1,2], function($v) { $item })");
    await assertRuntimeEquivalent(src, r.rewritten, "num", 7);
  });

  test("X as quoted object-key literal untouched; value position rewritten", async () => {
    const src = "{ 'num': num, 'idx': $loop_index }";
    const r = rewriteBareItemRefs(src, "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rewritten).toBe("{ 'num': $item, 'idx': $loop_index }");
    await assertRuntimeEquivalent(src, r.rewritten, "num", 5);
  });

  test("X inside string literals untouched", async () => {
    const src = "'num is ' & num & ' (num)'";
    const r = rewriteBareItemRefs(src, "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rewritten).toBe("'num is ' & $item & ' (num)'");
    await assertRuntimeEquivalent(src, r.rewritten, "num", 3);
  });

  test("X inside a filter predicate is an item-field lookup, untouched", () => {
    // `num` inside `[...]` resolves against each element of `items`,
    // NOT against the loop binding — must not be rewritten.
    const r = rewriteBareItemRefs("items[num > 2].x", "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.rewritten).toBe("items[num > 2].x");
  });

  test("non-head path steps are contextual, untouched: obj.num", () => {
    const r = rewriteBareItemRefs("obj.num", "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
  });

  test("head with predicate keeps the predicate: num[0].x → $item[0].x", async () => {
    const src = "num[0].x";
    const r = rewriteBareItemRefs(src, "num");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rewritten).toBe("$item[0].x");
    await assertRuntimeEquivalent(src, r.rewritten, "num", [{ x: "first" }, { x: "second" }]);
  });

  test("backtick-quoted name → proof path refuses (span mismatch), untouched", () => {
    const r = rewriteBareItemRefs("`num` * 2", "num");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("span mismatch");
  });

  test("$item shadowed by a lambda argument → refuses", () => {
    const r = rewriteBareItemRefs("$map(list, function($item) { num })", "num");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("shadowed");
  });

  test("$item shadowed by a := bind → refuses", () => {
    const r = rewriteBareItemRefs("($item := 1; num + $item)", "num");
    expect(r.ok).toBe(false);
  });

  test("syntactically invalid expression → refuses", () => {
    const r = rewriteBareItemRefs("num *", "num");
    expect(r.ok).toBe(false);
  });

  test("findBareItemRefs reports every root-context occurrence once", () => {
    const found = findBareItemRefs("num + num.x + other", new Set(["num", "other"]));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.refs.map((r) => r.name).sort()).toEqual(["num", "num", "other"]);
  });
});

// ---------------------------------------------------------------------------
// Whole-definition rewrites
// ---------------------------------------------------------------------------

function defOf(steps: unknown[]): WorkflowDef {
  return WorkflowDefSchema.parse({ name: "fixture", steps });
}

describe("rewriteWorkflowItemVars — whole definitions", () => {
  test("simple loop: body expression rewritten, item_var removed, changes recorded", () => {
    const def = defOf([
      { id: "get_numbers", kind: "transform", expression: "[1, 2, 3]" },
      { id: "iter", kind: "loop", over: "get_numbers.data", item_var: "num", body: ["double"] },
      { id: "double", kind: "transform", expression: "num * 2" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    const loop = r.def.steps.find((s) => s.id === "iter") as { item_var?: string };
    expect(loop.item_var).toBeUndefined();
    const double = r.def.steps.find((s) => s.id === "double") as { expression?: string };
    expect(double.expression).toBe("$item * 2");
    expect(r.changes).toEqual([
      { step_id: "double", field: "expression", before: "num * 2", after: "$item * 2" },
    ]);
    // Input def must not be mutated.
    const origLoop = def.steps.find((s) => s.id === "iter") as { item_var?: string };
    expect(origLoop.item_var).toBe("num");
  });

  test("definition without item_var → unchanged, ok", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", body: ["b"] },
      { id: "b", kind: "transform", expression: "$item" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.def).toBe(def);
  });

  test("branch.when and nested loop over are rewritten", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[{ 'flag': true, 'items': [1] }]" },
      { id: "outer", kind: "loop", over: "get.data", item_var: "row", body: ["gate", "inner"] },
      { id: "gate", kind: "branch", when: "row.flag = true", then_steps: ["inner"] },
      { id: "inner", kind: "loop", over: "row.items", body: ["leaf"] },
      { id: "leaf", kind: "transform", expression: "$item" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gate = r.def.steps.find((s) => s.id === "gate") as { when?: string };
    expect(gate.when).toBe("$item.flag = true");
    const inner = r.def.steps.find((s) => s.id === "inner") as { over?: string };
    expect(inner.over).toBe("$item.items");
  });

  test("nested loops with same-name shadowing: each scope rewrites to its own $item", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[{ 'a': 1, 'items': [{ 'b': 2 }] }]" },
      { id: "outer", kind: "loop", over: "get.data", item_var: "x", body: ["t1", "inner"] },
      { id: "t1", kind: "transform", expression: "x.a" },
      { id: "inner", kind: "loop", over: "x.items", item_var: "x", body: ["t2"] },
      { id: "t2", kind: "transform", expression: "x.b" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.def.steps.map((s) => [s.id, s as Record<string, unknown>]));
    expect(byId.get("t1")?.expression).toBe("$item.a");
    // inner.over runs in the OUTER iteration scope — outer's x.
    expect(byId.get("inner")?.over).toBe("$item.items");
    // t2 runs in the INNER iteration scope — inner's x shadows outer.
    expect(byId.get("t2")?.expression).toBe("$item.b");
    expect(byId.get("outer")?.item_var).toBeUndefined();
    expect(byId.get("inner")?.item_var).toBeUndefined();
  });

  test("cross-scope reference to an OUTER loop's item from a nested body → refuses", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[{ 'name': 'p', 'children': [1] }]" },
      { id: "outer", kind: "loop", over: "get.data", item_var: "p", body: ["inner"] },
      { id: "inner", kind: "loop", over: "p.children", item_var: "q", body: ["leaf"] },
      { id: "leaf", kind: "transform", expression: "p.name & ': ' & q" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("OUTER loop");
    expect(r.step_id).toBe("leaf");
  });

  test("JavaScript site reading the binding through scope → refuses", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[{ 'name': 'a' }]" },
      { id: "iter", kind: "loop", over: "get.data", item_var: "row", body: ["js"] },
      {
        id: "js",
        kind: "transform",
        language: "javascript",
        expression: "return scope.row.name;",
      },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("JavaScript");
    expect(r.step_id).toBe("js");
  });

  test("equivalence-proof / analysis failure inside a body step → workflow refused, untouched", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[1]" },
      { id: "iter", kind: "loop", over: "get.data", item_var: "num", body: ["bad"] },
      // `$item` lambda arg shadows the canonical binding around a bare
      // `num` ref — no provable rewrite exists.
      { id: "bad", kind: "transform", expression: "$map(list, function($item) { num })" },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.step_id).toBe("bad");
    // Caller contract: on ok:false the workflow is left untouched —
    // the original def still declares item_var.
    const loop = def.steps.find((s) => s.id === "iter") as { item_var?: string };
    expect(loop.item_var).toBe("num");
  });

  test("string-placeholder-only body (item placeholder): nothing to rewrite, item_var still removed", () => {
    const def = defOf([
      { id: "get", kind: "transform", expression: "[{ 'id': 'a' }]" },
      { id: "iter", kind: "loop", over: "get.data", item_var: "project", body: ["call"] },
      {
        id: "call",
        kind: "request",
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder is the tested grammar.
        url: "https://api.example.com/projects/${item.id}",
      },
    ]);
    const r = rewriteWorkflowItemVars(def);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.changes).toHaveLength(0);
    const loop = r.def.steps.find((s) => s.id === "iter") as { item_var?: string };
    expect(loop.item_var).toBeUndefined();
  });
});
