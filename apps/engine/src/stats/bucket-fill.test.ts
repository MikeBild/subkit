import { describe, expect, test } from "bun:test";
import { fillBuckets, fillGroups } from "./bucket-fill.ts";

const zero = (ts: string) => ({ ts, n: 0 });

describe("fillBuckets", () => {
  test("every expected bucket is present, empty ones carry zero", () => {
    expect(fillBuckets(["a", "b", "c"], [{ ts: "b", n: 3 }], zero)).toEqual([
      { ts: "a", n: 0 },
      { ts: "b", n: 3 },
      { ts: "c", n: 0 },
    ]);
  });

  test("an empty window still yields one zero bucket per key", () => {
    expect(fillBuckets(["a", "b"], [], zero)).toEqual([zero("a"), zero("b")]);
  });

  test("a bucket outside the expected keys is kept in time order instead of dropped", () => {
    expect(fillBuckets(["b"], [{ ts: "c", n: 1 }], zero).map((b) => b.ts)).toEqual(["b", "c"]);
  });

  test("no expected keys leaves the data untouched", () => {
    expect(fillBuckets([], [{ ts: "a", n: 1 }], zero)).toEqual([{ ts: "a", n: 1 }]);
  });
});

describe("fillGroups", () => {
  test("each group is filled on its own and keeps its other fields", () => {
    const groups = [
      { key: { s: "ok" }, buckets: [{ ts: "a", n: 1 }] },
      { key: { s: "bad" }, buckets: [{ ts: "b", n: 2 }] },
    ];
    expect(fillGroups(groups, ["a", "b"], zero)).toEqual([
      { key: { s: "ok" }, buckets: [{ ts: "a", n: 1 }, zero("b")] },
      { key: { s: "bad" }, buckets: [zero("a"), { ts: "b", n: 2 }] },
    ]);
  });
});
