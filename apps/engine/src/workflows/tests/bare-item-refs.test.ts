import { describe, expect, test } from "bun:test";
import { buildJsonataBindings } from "../../execution/jsonata-bindings.ts";
import { compile as compileJsonata } from "../../execution/jsonata-engine.ts";
import { findBareItemRefs, rewriteBareItemRefs } from "../bare-item-refs.ts";

async function evalWithScope(expression: string, scope: Record<string, unknown>): Promise<unknown> {
  return compileJsonata(expression).evaluate(scope, buildJsonataBindings(scope, null));
}

async function assertRuntimeEquivalent(
  original: string,
  rewritten: string,
  name: string,
  item: unknown,
  baseScope: Record<string, unknown> = {},
): Promise<void> {
  const bareScope = { ...baseScope, [name]: item, $item: item, $loop_index: 0 };
  const canonicalScope = { ...baseScope, $item: item, $loop_index: 0 };
  const before = await evalWithScope(original, bareScope);
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
