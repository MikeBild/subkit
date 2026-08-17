import { describe, expect, test } from "bun:test";
import { computeLineDiff, isUnchanged, toDiffLines } from "./line-diff";

describe("line diff", () => {
  test("marks only the changed line", () => {
    const lines = computeLineDiff(["a", "b", "c"], ["a", "B", "c"]);
    expect(lines).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  test("reports additions and removals at the edges", () => {
    expect(computeLineDiff([], ["new"])).toEqual([{ type: "added", text: "new" }]);
    expect(computeLineDiff(["old"], [])).toEqual([{ type: "removed", text: "old" }]);
  });

  test("recognises an unchanged shape", () => {
    expect(isUnchanged(computeLineDiff(["a"], ["a"]))).toBe(true);
    expect(isUnchanged(computeLineDiff(["a"], ["b"]))).toBe(false);
  });

  test("renders objects with stable key order so reordering is not a diff", () => {
    const before = toDiffLines({ kind: "request", id: "one" });
    const after = toDiffLines({ id: "one", kind: "request" });
    expect(before).toEqual(after);
  });

  test("renders a missing shape as no lines", () => {
    expect(toDiffLines(null)).toEqual([]);
    expect(toDiffLines(undefined)).toEqual([]);
  });

  test("keeps a string payload as its own lines", () => {
    expect(toDiffLines("first\nsecond")).toEqual(["first", "second"]);
  });
});
