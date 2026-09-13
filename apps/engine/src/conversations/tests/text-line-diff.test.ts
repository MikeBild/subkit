// Pure-function tests for the line-diff utility.

import { describe, expect, test } from "bun:test";

import { canonicalJson, computeLineDiff } from "../text-line-diff.ts";

describe("computeLineDiff", () => {
  test("flags an inserted line", () => {
    const hunks = computeLineDiff("a\nb", "a\nx\nb");
    expect(hunks.some((h) => h.kind === "+" && h.text === "x")).toBe(true);
  });

  test("flags a removed line", () => {
    const hunks = computeLineDiff("a\nb\nc", "a\nc");
    expect(hunks.some((h) => h.kind === "-" && h.text === "b")).toBe(true);
  });

  test("identical inputs produce only context hunks", () => {
    const hunks = computeLineDiff("a\nb", "a\nb");
    expect(hunks.every((h) => h.kind === " ")).toBe(true);
  });

  test("preserves both halves on full replacement", () => {
    const hunks = computeLineDiff("a\nb", "x\ny");
    const minuses = hunks.filter((h) => h.kind === "-").map((h) => h.text);
    const pluses = hunks.filter((h) => h.kind === "+").map((h) => h.text);
    expect(minuses).toContain("a");
    expect(minuses).toContain("b");
    expect(pluses).toContain("x");
    expect(pluses).toContain("y");
  });

  test("collapses long unchanged stretches between changes", () => {
    const before = ["@", ...Array.from({ length: 30 }, (_, i) => `line${i}`), "%"].join("\n");
    const after = ["@!", ...Array.from({ length: 30 }, (_, i) => `line${i}`), "%!"].join("\n");
    const hunks = computeLineDiff(before, after, { context: 3 });
    expect(hunks.some((h) => h.text === "…" && h.kind === " ")).toBe(true);
  });
});

describe("canonicalJson", () => {
  test("sorts keys deterministically", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  test("handles nested arrays + objects", () => {
    const json = canonicalJson({ x: [{ b: 1, a: 2 }] });
    expect(json).toContain('"a": 2');
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"b"'));
  });

  test("returns 'null' for nullish input", () => {
    expect(canonicalJson(null)).toBe("null");
  });
});
