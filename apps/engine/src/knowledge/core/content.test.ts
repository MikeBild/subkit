import { expect, test } from "bun:test";
import fc from "fast-check";
import { assessSourceSize, decodeUpload, knowledgeContentHash, toSlug } from "./content.ts";

test("source size uses UTF-8 bytes and accepts the exact limit", () => {
  expect(assessSourceSize("é", 2)).toEqual({ kind: "within_limit", bytes: 2 });
  expect(assessSourceSize("é", 1)).toEqual({ kind: "exceeded", bytes: 2 });
  expect(assessSourceSize("", 0)).toEqual({ kind: "within_limit", bytes: 0 });
});

test("decoding preserves text and decodes byte uploads without changing their buffers", () => {
  expect(decodeUpload("ä text")).toBe("ä text");
  const bytes = new Uint8Array([0xc3, 0xa4]);
  expect(decodeUpload(bytes)).toBe("ä");
  expect(bytes).toEqual(new Uint8Array([0xc3, 0xa4]));
  expect(decodeUpload(Buffer.from("hello"))).toBe("hello");
});

test("content hash covers exact content rather than chunk-normalized text", () => {
  expect(knowledgeContentHash("hello world")).toBe("b94d27b9934d3e08a52e52d7da7dabfa");
  expect(knowledgeContentHash("Hello world")).not.toBe(knowledgeContentHash("hello world"));
  expect(knowledgeContentHash("hello world ")).not.toBe(knowledgeContentHash("hello world"));
});

test("slugs retain historical ASCII folding, separator and length rules", () => {
  expect(toSlug("  Hello / World! ")).toBe("hello-world");
  expect(toSlug("Ä")).toBe("");
  expect(toSlug("a".repeat(105))).toBe("a".repeat(100));
  fc.assert(
    fc.property(fc.string(), (name) => {
      const slug = toSlug(name);
      expect(slug.length).toBeLessThanOrEqual(100);
      expect(toSlug(slug)).toBe(slug.replace(/^-|-$/g, ""));
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
