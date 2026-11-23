import { describe, expect, test } from "bun:test";
import { fuseByReciprocalRank, keepTopScored } from "./rank-fusion.ts";

const id = (s: string) => s;

describe("fuseByReciprocalRank", () => {
  test("an item found by both lists beats the top of a single list", () => {
    const out = fuseByReciprocalRank({
      lists: [
        ["text-only", "both"],
        ["vector-only", "both"],
      ],
      idOf: id,
      limit: 10,
    });
    expect(out[0]).toBe("both");
    expect(new Set(out)).toEqual(new Set(["both", "text-only", "vector-only"]));
  });

  test("a vector hit no longer outranks every text hit", () => {
    const out = fuseByReciprocalRank({
      lists: [
        ["t1", "t2", "t3"],
        ["v1", "v2", "v3"],
      ],
      idOf: id,
      limit: 6,
    });
    expect(out).toEqual(["t1", "v1", "t2", "v2", "t3", "v3"]);
  });

  test("ties keep first-seen order and the limit is honoured", () => {
    const out = fuseByReciprocalRank({ lists: [["a", "b"], ["c"]], idOf: id, limit: 2 });
    expect(out).toEqual(["a", "c"]);
  });

  test("a repeated id inside one list counts once", () => {
    const out = fuseByReciprocalRank({ lists: [["a", "a", "b"], ["b"]], idOf: id, limit: 5 });
    expect(out).toEqual(["b", "a"]);
  });

  test("a smaller constant sharpens the head of each list", () => {
    const lists = [["a", "x", "y", "b"], ["b"]];
    expect(fuseByReciprocalRank({ lists, idOf: id, limit: 1, k: 60 })).toEqual(["b"]);
    expect(fuseByReciprocalRank({ lists, idOf: id, limit: 1, k: 0 })).toEqual(["b"]);
    expect(
      fuseByReciprocalRank({
        lists: [
          ["a", "x", "y", "b"],
          ["z", "b"],
        ],
        idOf: id,
        limit: 1,
        k: 0,
      }),
    ).toEqual(["a"]);
  });

  test("empty input and a zero limit return nothing", () => {
    expect(fuseByReciprocalRank({ lists: [], idOf: id, limit: 5 })).toEqual([]);
    expect(fuseByReciprocalRank({ lists: [["a"]], idOf: id, limit: 0 })).toEqual([]);
  });
});

describe("keepTopScored", () => {
  test("keeps only the best scores in descending order", () => {
    const top: Array<{ item: string; score: number }> = [];
    for (const [item, score] of [
      ["a", 0.2],
      ["b", 0.9],
      ["c", 0.5],
      ["d", 0.1],
      ["e", 0.7],
    ] as const) {
      keepTopScored(top, { item, score }, 3);
    }
    expect(top.map((t) => t.item)).toEqual(["b", "e", "c"]);
  });

  test("an equal score does not displace an earlier candidate", () => {
    const top: Array<{ item: string; score: number }> = [];
    keepTopScored(top, { item: "first", score: 0.5 }, 1);
    keepTopScored(top, { item: "second", score: 0.5 }, 1);
    expect(top.map((t) => t.item)).toEqual(["first"]);
  });

  test("a size of zero keeps nothing", () => {
    const top: Array<{ item: string; score: number }> = [];
    keepTopScored(top, { item: "a", score: 1 }, 0);
    expect(top).toEqual([]);
  });
});
