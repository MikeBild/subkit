import { describe, expect, test } from "bun:test";

import { fingerprintChunks } from "../chunker.ts";
import { dedupChunks, jaccard } from "../dedup.ts";
import type { RawChunk } from "../types.ts";

function chunk(content: string, title = "t"): RawChunk {
  return { title, path: null, content };
}

describe("docs-ingestion/dedup", () => {
  test("identical chunks collapse to one", () => {
    const raw = [chunk("hello world this is a test"), chunk("hello world this is a test")];
    const fp = fingerprintChunks(raw);
    const { accepted, skipped } = dedupChunks(fp);
    expect(accepted.length).toBe(1);
    expect(skipped).toBe(1);
  });

  test("near-duplicates above 90% similarity collapse", () => {
    // Two texts that share ~95% of their 5-gram shingles (one word added).
    const base = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const tweaked = `${base} extra`;
    const fp = fingerprintChunks([chunk(base), chunk(tweaked)]);
    // Sanity: ensure similarity is >= 0.9 before we assert dedup.
    expect(jaccard(fp[0]!.shingles, fp[1]!.shingles)).toBeGreaterThanOrEqual(0.9);
    const { accepted, skipped } = dedupChunks(fp);
    expect(accepted.length).toBe(1);
    expect(skipped).toBe(1);
  });

  test("70%-similar chunks are kept as distinct", () => {
    // Share roughly 7/10 shingles — well below the 0.9 threshold.
    const a = "one two three four five six seven eight nine ten";
    const b = "one two three four five six seven apple banana cherry";
    const fp = fingerprintChunks([chunk(a), chunk(b)]);
    expect(jaccard(fp[0]!.shingles, fp[1]!.shingles)).toBeLessThan(0.9);
    const { accepted, skipped } = dedupChunks(fp);
    expect(accepted.length).toBe(2);
    expect(skipped).toBe(0);
  });
});
