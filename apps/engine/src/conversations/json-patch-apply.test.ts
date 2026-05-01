// Bug TT regression: applyDiffsToConfig + partitionDiffs are pure
// JSON-Patch helpers powering per-patch partial approval. Mirrors
// reference impl's config-diff-utils.ts.

import { describe, expect, test } from "bun:test";
import {
  applyApprovedDiffs,
  applyDiffsToConfig,
  partitionDiffs,
  type ToolDiff,
} from "./json-patch-apply.ts";

describe("applyDiffsToConfig", () => {
  test("returns input unchanged when diffs is empty", () => {
    const config = { a: 1, b: { c: 2 } };
    const result = applyDiffsToConfig(config, []);
    expect(result).toEqual(config);
  });

  test("applies a single replace patch", () => {
    const config = { a: 1, b: { c: 2 } };
    const diffs: ToolDiff[] = [{ op: "replace", path: "/a", value: 99 }];
    const result = applyDiffsToConfig(config, diffs);
    expect(result).toEqual({ a: 99, b: { c: 2 } });
  });

  test("applies multiple patches in order", () => {
    const config: Record<string, number> = { a: 1, b: 2, c: 3 };
    const diffs: ToolDiff[] = [
      { op: "replace", path: "/a", value: 10 },
      { op: "replace", path: "/b", value: 20 },
      { op: "remove", path: "/c" },
    ];
    const result = applyDiffsToConfig(config, diffs);
    expect(result).toEqual({ a: 10, b: 20 });
  });

  test("does NOT mutate the input config", () => {
    const config = { a: 1, b: { c: 2 } };
    const diffs: ToolDiff[] = [{ op: "replace", path: "/b/c", value: 99 }];
    applyDiffsToConfig(config, diffs);
    expect(config).toEqual({ a: 1, b: { c: 2 } });
  });

  test("throws on illegal patch (path doesn't exist)", () => {
    const config = { a: 1 };
    const diffs: ToolDiff[] = [{ op: "replace", path: "/does/not/exist", value: 1 }];
    expect(() => applyDiffsToConfig(config, diffs)).toThrow();
  });
});

describe("partitionDiffs", () => {
  test("splits diffs by approved index", () => {
    const diffs: ToolDiff[] = [
      { op: "replace", path: "/a", value: 1 },
      { op: "replace", path: "/b", value: 2 },
      { op: "replace", path: "/c", value: 3 },
    ];
    const { approved, rejected } = partitionDiffs(diffs, [0, 2]);
    expect(approved).toEqual([
      { op: "replace", path: "/a", value: 1 },
      { op: "replace", path: "/c", value: 3 },
    ]);
    expect(rejected).toEqual([{ op: "replace", path: "/b", value: 2 }]);
  });

  test("preserves order within each output", () => {
    const diffs: ToolDiff[] = [
      { op: "replace", path: "/a", value: 1 },
      { op: "replace", path: "/b", value: 2 },
      { op: "replace", path: "/c", value: 3 },
      { op: "replace", path: "/d", value: 4 },
    ];
    // Approved indices in non-sorted order — output order should
    // still match the original.
    const { approved } = partitionDiffs(diffs, [3, 0]);
    expect(approved.map((d) => d.path)).toEqual(["/a", "/d"]);
  });

  test("empty approved → all rejected", () => {
    const diffs: ToolDiff[] = [{ op: "replace", path: "/a", value: 1 }];
    const { approved, rejected } = partitionDiffs(diffs, []);
    expect(approved).toEqual([]);
    expect(rejected).toEqual(diffs);
  });
});

describe("applyApprovedDiffs · end-to-end partial approval (Bug TT)", () => {
  test("applies only the approved subset to the config", () => {
    const config = { a: 1, b: 2, c: 3 };
    const diffs: ToolDiff[] = [
      { op: "replace", path: "/a", value: 10 },
      { op: "replace", path: "/b", value: 20 },
      { op: "replace", path: "/c", value: 30 },
    ];
    // Operator approved diffs 0 and 2 (a + c), rejected b.
    const result = applyApprovedDiffs(config, diffs, [0, 2]);
    expect(result).toEqual({ a: 10, b: 2, c: 30 });
  });

  test("approved=[] is a no-op (operator rejected everything)", () => {
    const config = { a: 1 };
    const diffs: ToolDiff[] = [{ op: "replace", path: "/a", value: 99 }];
    const result = applyApprovedDiffs(config, diffs, []);
    expect(result).toEqual({ a: 1 });
  });
});
