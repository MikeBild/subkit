import { describe, expect, test } from "bun:test";
import { skillExamplesFromBlob } from "./examples-blob.ts";

const empty = { examples: [], best_practices: [], pitfalls: [], doc_refs: [] };

describe("skillExamplesFromBlob", () => {
  test.each([
    [
      "blob object",
      { examples: ["a", "b"], best_practices: ["bp"], pitfalls: ["p"], doc_refs: ["d"] },
      { examples: ["a", "b"], best_practices: ["bp"], pitfalls: ["p"], doc_refs: ["d"] },
    ],
    ["legacy array", ["first", "second"], { ...empty, examples: ["first", "second"] }],
    ["null", null, empty],
    ["undefined", undefined, empty],
    ["scalar", "loose text", empty],
    [
      "non-array fields",
      { examples: "x", best_practices: { a: 1 }, pitfalls: null, doc_refs: 3 },
      empty,
    ],
    ["partial blob", { examples: ["only"] }, { ...empty, examples: ["only"] }],
  ])("%s", (_label, input, expected) => {
    expect(skillExamplesFromBlob(input)).toEqual(expected);
  });
});
