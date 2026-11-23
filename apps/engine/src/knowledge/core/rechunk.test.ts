import { describe, expect, test } from "bun:test";
import { byteLen } from "./chunking.ts";
import { needsRechunk, rechunk } from "./rechunk.ts";

const paragraph = (label: string, words: number) =>
  Array.from({ length: words }, (_, i) => `${label}${i}`).join(" ");

describe("needsRechunk", () => {
  test("only a chunk above the target asks for a rewrite", () => {
    expect(needsRechunk([{ content: "small" }], 16)).toBe(false);
    expect(needsRechunk([{ content: "small" }, { content: "x".repeat(17) }], 16)).toBe(true);
    expect(needsRechunk([], 16)).toBe(false);
  });
});

describe("rechunk", () => {
  test("a chunk within the target is kept as it is", () => {
    const out = rechunk([{ title: "Intro", path: "a.md", content: "short text" }], 64);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Intro", path: "a.md", content: "short text" });
    expect(out[0]?.byte_size).toBe(10);
    expect(out[0]?.fingerprint).toHaveLength(32);
  });

  test("a large chunk is split into numbered parts within the target", () => {
    const content = [paragraph("a", 20), paragraph("b", 20), paragraph("c", 20)].join("\n\n");
    const out = rechunk([{ title: "Guide", path: "g.md", content }], 120);
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((c) => c.title)).toEqual(out.map((_, i) => `Guide (part ${i + 1})`));
    for (const chunk of out) expect(byteLen(chunk.content)).toBeLessThanOrEqual(120);
    expect(
      out
        .map((c) => c.content)
        .join(" ")
        .split(/\s+/),
    ).toEqual(content.split(/\s+/));
  });

  test("earlier parts of one section are merged before they are split again", () => {
    const out = rechunk(
      [
        { title: "Guide (part 1)", path: "g.md", content: paragraph("a", 30) },
        { title: "Guide (part 2)", path: "g.md", content: paragraph("b", 30) },
        { title: "Other", path: "g.md", content: "tail" },
      ],
      100,
    );
    const guide = out.filter((c) => c.title?.startsWith("Guide"));
    expect(guide.map((c) => c.title)).toEqual(guide.map((_, i) => `Guide (part ${i + 1})`));
    expect(out[out.length - 1]).toMatchObject({ title: "Other", content: "tail" });
  });

  test("parts of different files or sections are never merged", () => {
    const out = rechunk(
      [
        { title: "Guide (part 1)", path: "a.md", content: "one" },
        { title: "Guide (part 2)", path: "b.md", content: "two" },
        { title: "Manual (part 1)", path: "b.md", content: "three" },
      ],
      64,
    );
    expect(out.map((c) => [c.title, c.path, c.content])).toEqual([
      ["Guide", "a.md", "one"],
      ["Guide", "b.md", "two"],
      ["Manual", "b.md", "three"],
    ]);
  });

  test("an untitled part keeps an empty title prefix only when it is split", () => {
    const merged = rechunk([{ title: " (part 1)", path: null, content: "one" }], 64);
    expect(merged[0]?.title).toBeNull();
    const split = rechunk([{ title: null, path: null, content: "aaaa bbbb cccc" }], 5);
    expect(split.map((c) => c.title)).toEqual([" (part 1)", " (part 2)", " (part 3)"]);
  });
});
