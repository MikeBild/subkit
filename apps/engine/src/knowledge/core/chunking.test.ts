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
});

test("splitting respects paragraph/sentence boundaries and retains the established hard-split behavior", () => {
  expect(splitByBudget("small", 8)).toEqual(["small"]);
  expect(splitByBudget("one\n\ntwo\n\nthree", 8)).toEqual(["one\n\ntwo", "three"]);
  expect(splitByBudget("Hi. Bye. Longtext", 8)).toEqual(["Hi. Bye.", "Longtext"]);
  expect(splitByBudget("123456789", 4)).toEqual(["1234", "5678", "9"]);
  expect(splitByBudget("123456789\n\na", 4)).toEqual(["1234", "5678", "9\n\na"]);
  expect(splitByBudget("")).toEqual([""]);
  expect(trimToBytes("abc", 3)).toBe("abc");
  expect(trimToBytes("ééé", 5)).toBe("éé");
  expect(trimToBytes("é", 1)).toBe("");
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
