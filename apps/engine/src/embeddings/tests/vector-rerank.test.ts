import { describe, expect, test } from "bun:test";
import { type QueryEmbedder, vectorScoreCandidates } from "../vector-rerank.ts";

const stub = (q: number[]): QueryEmbedder => ({
  available: async () => true,
  embed: async () => q,
});

describe("vectorScoreCandidates", () => {
  const candidates = [
    { item: { id: "near" }, embedding: [1, 0, 0] },
    { item: { id: "far" }, embedding: [0, 1, 0] },
    { item: { id: "noemb" }, embedding: null },
  ];

  test("ranks by cosine and drops below-floor + null-embedding candidates", async () => {
    const scored = await vectorScoreCandidates("payment", candidates, {
      embedder: stub([1, 0, 0]),
      minCosine: 0.3,
    });
    expect(scored.map((s) => s.item.id)).toEqual(["near"]);
    expect(scored[0]!.cosine).toBeCloseTo(1, 5);
  });

  test("returns [] when embeddings are unavailable", async () => {
    const offline: QueryEmbedder = { available: async () => false, embed: async () => null };
    const scored = await vectorScoreCandidates("payment", candidates, { embedder: offline });
    expect(scored).toEqual([]);
  });

  test("returns [] for an empty query", async () => {
    const scored = await vectorScoreCandidates("  ", candidates, {
      embedder: stub([1, 0, 0]),
    });
    expect(scored).toEqual([]);
  });
});
