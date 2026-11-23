import { describe, expect, test } from "bun:test";
import { earlierVersions, forgetChain } from "./forget-chain.ts";

const rows = [
  { id: "v1", replaced_by: "v2" },
  { id: "v2", replaced_by: "v3" },
  { id: "v3", replaced_by: null },
  { id: "merged", replaced_by: "v3" },
  { id: "other", replaced_by: null },
  { id: "other-old", replaced_by: "other" },
];

describe("forgetChain", () => {
  test("forgetting the current note takes every earlier version with it", () => {
    expect(forgetChain(rows, "v3").sort()).toEqual(["merged", "v1", "v2", "v3"]);
  });

  test("the forgotten note comes first", () => {
    expect(forgetChain(rows, "v3")[0]).toBe("v3");
  });

  test("forgetting an earlier version leaves its successor alone", () => {
    expect(forgetChain(rows, "v2")).toEqual(["v2", "v1"]);
  });

  test("a note without history is forgotten alone, an unknown id forgets nothing", () => {
    expect(forgetChain(rows, "v1")).toEqual(["v1"]);
    expect(forgetChain(rows, "missing")).toEqual([]);
  });

  test("a cycle in the chain ends", () => {
    const cycle = [
      { id: "a", replaced_by: "b" },
      { id: "b", replaced_by: "a" },
    ];
    expect(forgetChain(cycle, "a")).toEqual(["a", "b"]);
  });
});

describe("earlierVersions", () => {
  test("lists the versions a note replaced, nearest first, without the note itself", () => {
    expect(earlierVersions(rows, "v3").map((row) => row.id)).toEqual(["v2", "merged", "v1"]);
    expect(earlierVersions(rows, "v1")).toEqual([]);
  });
});
