import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  byteLen,
  canonicalize,
  fingerprint,
  shingles,
  splitByBudget,
  trimToBytes,
} from "./chunking.ts";
import { dedupChunks, jaccard } from "./dedup.ts";

const chunk = (content: string) => ({
  content,
  fingerprint: fingerprint(content),
  shingles: shingles(content),
  byte_size: byteLen(content),
});

test("fingerprints and shingles normalize case and whitespace without changing input", () => {
  expect(canonicalize("  Hello\n WORLD\t")).toBe("hello world");
  expect(fingerprint("Hello WORLD")).toBe("b94d27b9934d3e08a52e52d7da7dabfa");
  expect(shingles(" ")).toEqual(new Set());
  expect(shingles("one two")).toEqual(shingles("ONE  two"));
  expect(shingles("one two three four five six").size).toBe(2);
  expect(shingles("one two three four five").size).toBe(1);
  expect([...shingles("one two three four five")]).toEqual([437486757]);
  expect([...shingles("one two three four five six")]).toEqual([437486757, 1622303317]);
  expect([...shingles("one two")]).toEqual([1120043585]);
});

test("splitting respects paragraph/sentence boundaries and retains the established hard-split behavior", () => {
  expect(splitByBudget("x")).toEqual(["x"]);
  expect(splitByBudget("ab", 1)).toEqual(["a", "b"]);
  expect(splitByBudget("small", 8)).toEqual(["small"]);
  expect(splitByBudget("one\n\ntwo\n\nthree", 8)).toEqual(["one\n\ntwo", "three"]);
  expect(splitByBudget("Hi. Bye. Longtext", 8)).toEqual(["Hi. Bye.", "Longtext"]);
  expect(splitByBudget("123456789", 4)).toEqual(["1234", "5678", "9"]);
  expect(splitByBudget("123456789\n\na", 4)).toEqual(["1234", "5678", "9\n\na"]);
  expect(splitByBudget("")).toEqual([""]);
  expect(trimToBytes("abc", 3)).toBe("abc");
  expect(trimToBytes("ééé", 5)).toBe("éé");
  expect(trimToBytes("é", 1)).toBe("");
  expect(trimToBytes("éa", 2)).toBe("é");
  expect(trimToBytes("éa", 3)).toBe("éa");
  expect(trimToBytes("abc", 2)).toBe("ab");
  expect([0, 1, 2, 3, 4, 5].map((cap) => trimToBytes("😀", cap))).toEqual([
    "",
    "",
    "",
    "",
    "😀",
    "😀",
  ]);
  expect(trimToBytes("a😀", 4)).toBe("a");
  expect(trimToBytes("a😀", 5)).toBe("a😀");
  expect(trimToBytes("x", Number.NaN)).toBe("");
  expect(trimToBytes("x", Number.POSITIVE_INFINITY)).toBe("x");
  expect(trimToBytes("x", Number.NEGATIVE_INFINITY)).toBe("");
  expect(trimToBytes("xy", 1.5)).toBe("x");
  expect(trimToBytes("x", -1)).toBe("");
  expect(splitByBudget("abcd", 4)).toEqual(["abcd"]);
  expect(splitByBudget("abcd e", 4)).toEqual(["abcd", " e"]);
  expect(splitByBudget("a. b", 3)).toEqual(["a.", "b"]);
  expect(splitByBudget("a. b", 4)).toEqual(["a. b"]);
  expect(splitByBudget("aa. b", 4)).toEqual(["aa.", "b"]);
  expect(splitByBudget("aa.  b", 5)).toEqual(["aa. b"]);
  expect(splitByBudget("a\n\nb", 2)).toEqual(["a", "b"]);
  expect(splitByBudget("a\n\nb\n\nc", 2)).toEqual(["a", "b", "c"]);
  expect(splitByBudget("a\n\n\nb", 5)).toEqual(["a\n\n\nb"]);
  expect(splitByBudget("aa.  b\n\nx", 6)).toEqual(["aa.  b", "x"]);
  expect(splitByBudget("a. 12345", 4)).toEqual(["a.", "1234", "5"]);
  expect(splitByBudget("a\n\nb. xxxxxxx", 6)).toEqual(["a", "b.", "xxxxxx", "x"]);
  expect(splitByBudget("xxxxxxx. b.", 6)).toEqual(["xxxxxx", "x.\n\nb."]);
  expect(splitByBudget("tiny\n\n123456789", 8)).toEqual(["tiny", "12345678", "9"]);
  expect(splitByBudget("ab\n\ncd", 6)).toEqual(["ab\n\ncd"]);
  expect(splitByBudget("12345678", 4)).toEqual(["1234", "5678"]);
  expect(splitByBudget("ééé", 4)).toEqual(["éé", "é"]);
  expect(splitByBudget("😀😀", 4)).toEqual(["😀", "😀"]);
  expect(splitByBudget("éé", 3)).toEqual(["é", "é"]);
  const longAscii = "x".repeat(200_000);
  const longPieces = splitByBudget(longAscii, 1);
  expect(longPieces).toHaveLength(200_000);
  expect(longPieces.every((piece) => piece === "x")).toBe(true);
});

test("splitting rejects budgets that cannot make hard-split progress", () => {
  for (const budget of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => splitByBudget("x", budget)).toThrow(
      new RangeError("splitByBudget budget must be a positive safe integer"),
    );
  }
});

test("hard splitting preserves complete code points within the UTF-8 budget", () => {
  for (const [text, budget] of [
    ["ééé", 4],
    ["😀😀", 4],
    ["éé", 3],
  ] as const) {
    const pieces = splitByBudget(text, budget);
    expect(pieces.join("")).toBe(text);
    expect(pieces.every((piece) => byteLen(piece) <= budget)).toBe(true);
  }
  expect(() => splitByBudget("😀", 3)).toThrow(
    new RangeError("splitByBudget budget must accommodate every UTF-8 code point"),
  );
});

test("jaccard and duplicate admission use inclusive threshold and retain the first representative", () => {
  expect(jaccard(new Set(), new Set())).toBe(1);
  expect(jaccard(new Set(), new Set([1]))).toBe(0);
  expect(jaccard(new Set([1]), new Set())).toBe(0);
  expect(jaccard(new Set([1, 2]), new Set([2]))).toBe(0.5);
  expect(jaccard(new Set([2]), new Set([1, 2]))).toBe(0.5);
  const first = chunk("one two three four five");
  const duplicate = chunk("ONE TWO THREE FOUR FIVE");
  const other = chunk("unrelated words entirely");
  expect(dedupChunks([first, duplicate, other], 0.9)).toEqual({
    accepted: [first, other],
    skipped: 1,
  });
  const overlap = { ...other, shingles: new Set([...first.shingles]) };
  expect(dedupChunks([first, overlap], 1)).toEqual({ accepted: [first], skipped: 1 });
  expect(dedupChunks([], 0.9)).toEqual({ accepted: [], skipped: 0 });
  expect(jaccard(new Set([1, 2, 3]), new Set([1, 2, 4, 5]))).toBe(0.4);
  expect(jaccard(new Set([1, 2, 3]), new Set([3, 4]))).toBe(0.25);
  expect(dedupChunks([first, overlap], 1.0001)).toEqual({ accepted: [first, overlap], skipped: 0 });
  const sameFingerprintDifferentContent = { ...other, fingerprint: first.fingerprint };
  expect(dedupChunks([first, sameFingerprintDifferentContent], 1.0001)).toEqual({
    accepted: [first],
    skipped: 1,
  });
});

test("explicit UTF-8 caps and duplicate admission are deterministic for frozen inputs", () => {
  fc.assert(
    fc.property(fc.string(), fc.integer({ min: 0, max: 30 }), (content, cap) => {
      const result = trimToBytes(content, cap);
      expect(byteLen(result)).toBeLessThanOrEqual(cap);
      expect(content.startsWith(result)).toBe(true);
      const value = Object.freeze(chunk(content));
      expect(dedupChunks(Object.freeze([value, value]), 0.9)).toEqual({
        accepted: [value],
        skipped: 1,
      });
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
