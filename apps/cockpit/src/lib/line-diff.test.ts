import { describe, expect, test } from "bun:test";

import { computeLineDiff, isUnchanged, selectChangeView, toDiffLines } from "./line-diff";

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

describe("what a proposal shows", () => {
  test("prefers a real before-and-after", () => {
    const view = selectChangeView({
      before: { kind: "request", path: "/a" },
      after: { kind: "request", path: "/b" },
      patch: { ignored: true },
    });
    expect(view.kind).toBe("diff");
  });

  test("falls back to the patch when a scan left no run to compare", () => {
    const view = selectChangeView({
      before: null,
      after: null,
      patch: { revision: { properties: { published_at: { type: "unknown" } } } },
    });
    expect(view.kind).toBe("patch");
    if (view.kind === "patch") expect(view.lines.join("\n")).toContain("published_at");
  });

  test("only reports 'unchanged' when there is genuinely nothing", () => {
    expect(selectChangeView({ before: null, after: null, patch: null }).kind).toBe("unchanged");
    expect(selectChangeView({ before: { a: 1 }, after: { a: 1 }, patch: null }).kind).toBe(
      "unchanged",
    );
  });
});
