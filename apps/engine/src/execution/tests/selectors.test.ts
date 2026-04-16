import { describe, expect, test } from "bun:test";
import { applySelector, compileSelector } from "../selectors.ts";

describe("JSONPath-lite selectors", () => {
  test("$.a.b[0]", () => {
    expect(applySelector("$.a.b[0]", { a: { b: [10, 20] } })).toBe(10);
  });
  test("$[0:2]", () => {
    expect(applySelector("$[0:2]", [1, 2, 3, 4])).toEqual([1, 2]);
  });
  test("$.items[*].name", () => {
    const value = { items: [{ name: "a" }, { name: "b" }] };
    expect(applySelector("$.items[*].name", value)).toEqual(["a", "b"]);
  });
  test("compile rejects bad input", () => {
    expect(() => compileSelector("a.b")).toThrow();
  });
  test("missing keys yield undefined", () => {
    expect(applySelector("$.x", {})).toBeUndefined();
  });
});
