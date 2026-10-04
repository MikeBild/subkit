import { describe, expect, test } from "bun:test";
import { fuseVectorFirst, type QueryEmbedder, vectorScoreCandidates } from "../vector-rerank.ts";

const stub = (q: number[]): QueryEmbedder => ({
  available: async () => true,
  embed: async () => q,
});

describe("fuseVectorFirst", () => {
  test("vector hits lead, FTS fills the remainder, dedup by id", () => {
    const fts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const vector = [
      { item: { id: "c" }, cosine: 0.9 },
      { item: { id: "d" }, cosine: 0.8 },
    ];
    const out = fuseVectorFirst({ fts, vector, idOf: (h) => h.id, limit: 4 });
    expect(out.map((h) => h.id)).toEqual(["c", "d", "a", "b"]);
  });

  test("empty vector → FTS order unchanged (today's behaviour)", () => {
    const fts = [{ id: "a" }, { id: "b" }];
    const out = fuseVectorFirst({ fts, vector: [], idOf: (h) => h.id, limit: 10 });
    expect(out.map((h) => h.id)).toEqual(["a", "b"]);
  });

  test("respects the limit", () => {
    const fts = [{ id: "a" }, { id: "b" }];
    const vector = [{ item: { id: "z" }, cosine: 0.9 }];
    const out = fuseVectorFirst({ fts, vector, idOf: (h) => h.id, limit: 2 });
    expect(out.map((h) => h.id)).toEqual(["z", "a"]);
  });
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
