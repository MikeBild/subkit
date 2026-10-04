import { describe, expect, test } from "bun:test";
import {
  buildScopeAtStep,
  enumerateScopePaths,
  pickPrimaryDataPath,
  summarizeScopeShape,
} from "../scope-shape.ts";

describe("enumerateScopePaths", () => {
  test("returns leaf paths for a flat object", () => {
    const paths = enumerateScopePaths({ id: 1, name: "Ada" });
    expect(paths).toContain("id");
    expect(paths).toContain("name");
  });

  test("indexes the first array element and emits a [*] sibling for the rest", () => {
    const paths = enumerateScopePaths({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(paths).toContain("items[0]");
    expect(paths).toContain("items[0].id");
    expect(paths).toContain("items[*]");
  });

  test("respects depth budget", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    const paths = enumerateScopePaths(deep, { depth_budget: 3 });
    expect(paths).toContain("a");
    expect(paths).toContain("a.b");
    expect(paths).toContain("a.b.c");
    expect(paths).not.toContain("a.b.c.d.e.f");
  });

  test("respects path budget", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) wide[`k${i}`] = i;
    const paths = enumerateScopePaths(wide, { path_budget: 16 });
    expect(paths.length).toBeLessThanOrEqual(16);
  });

  test("returns [] for null / undefined", () => {
    expect(enumerateScopePaths(null)).toEqual([]);
    expect(enumerateScopePaths(undefined)).toEqual([]);
  });
});

describe("summarizeScopeShape", () => {
  test("primitives", () => {
    expect(summarizeScopeShape("hi")).toBe("string");
    expect(summarizeScopeShape(7)).toBe("number");
    expect(summarizeScopeShape(true)).toBe("boolean");
    expect(summarizeScopeShape(null)).toBe("null");
  });

  test("array with object elements", () => {
    expect(summarizeScopeShape([{ id: 1 }, { id: 2 }])).toBe("array[2]<object>");
  });

  test("array of primitives", () => {
    expect(summarizeScopeShape([1, 2, 3])).toBe("array[3]<number>");
  });

  test("object inlines first three keys", () => {
    expect(summarizeScopeShape({ a: 1, b: 2, c: 3, d: 4 })).toBe("object{a,b,c,…+1}");
  });

  test("object array length annotation", () => {
    expect(summarizeScopeShape({ count: 5, results: [1, 2, 3] })).toBe("object{count,results[3]}");
  });
});

describe("pickPrimaryDataPath", () => {
  test("finds the canonical payload key", () => {
    expect(pickPrimaryDataPath({ data: [1, 2] })).toBe("data");
    expect(pickPrimaryDataPath({ results: [{ id: 1 }] })).toBe("results");
    expect(pickPrimaryDataPath({ rows: [] })).toBe("rows");
  });

  test("recurses through single-key wrappers", () => {
    expect(pickPrimaryDataPath({ envelope: { data: [1, 2] } })).toBe("envelope.data");
  });

  test("returns empty string for a top-level array (it IS the data)", () => {
    expect(pickPrimaryDataPath([1, 2, 3])).toBe("");
  });

  test("returns null when no payload key matches", () => {
    expect(pickPrimaryDataPath({ id: 1, name: "x" })).toBe(null);
  });

  test("walks single-key wrappers but stops at the depth budget", () => {
    expect(pickPrimaryDataPath({ a: { b: { c: { d: { e: { data: [] } } } } } })).toBe("a.b.c.d");
  });
});

describe("buildScopeAtStep", () => {
  test("returns paths + shape + primary_data_path together", () => {
    const env = buildScopeAtStep({
      data: {
        results: [{ id: 1, name: "Ada" }],
        count: 1,
      },
    });
    expect(env.shape_summary).toContain("data");
    expect(env.primary_data_path).toBe("data.results");
    expect(env.available_paths).toContain("data");
    expect(env.available_paths).toContain("data.results");
    expect(env.available_paths).toContain("data.count");
  });
});
