import { describe, expect, test } from "bun:test";
import { dedupeTags, isStructuralTag, mergeStructuralTags } from "./tags.ts";

describe("knowledge/isStructuralTag", () => {
  const structural = [
    "domain:blog-de",
    "café:paris",
    "café:paris",
    "_internal:x",
    "a:b",
    "3:4",
    "a-b-c:x",
  ];
  const topical = [
    "note: x",
    "note about: chords",
    "q&a:faq",
    "c++:tips",
    ".net:core",
    "blog-:notes",
    "x-:y",
    "-x:y",
    "todo:",
    "plain",
    "",
  ];

  for (const tag of structural) {
    test(`structural: ${JSON.stringify(tag)}`, () => {
      expect(isStructuralTag(tag)).toBe(true);
    });
  }
  for (const tag of topical) {
    test(`topical: ${JSON.stringify(tag)}`, () => {
      expect(isStructuralTag(tag)).toBe(false);
    });
  }
});

describe("knowledge/mergeStructuralTags", () => {
  test("preserves existing structural, replaces topical, mints no routing keys", () => {
    expect(
      mergeStructuralTags(
        ["domain:harmoniqs", "café:paris", "note: x", "blog-:notes"],
        ["akkorde", "domain:evil"],
      ),
    ).toEqual(["domain:harmoniqs", "café:paris", "akkorde"]);
  });
});

test("deduplication trims, removes empty/case duplicates and keeps first spelling", () => {
  expect(dedupeTags([" ", " First ", "FIRST", "second", "first"])).toEqual(["First", "second"]);
  expect(dedupeTags(["a".repeat(45)])).toEqual(["a".repeat(40)]);
  expect(dedupeTags(Array.from({ length: 25 }, (_, n) => `tag-${n}`))).toEqual(
    Array.from({ length: 20 }, (_, n) => `tag-${n}`),
  );
});
