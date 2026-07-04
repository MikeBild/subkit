// Hybrid retrieval fusion — vector-first with an FTS recall safety net.
//
// Used by searchKnowledge / searchDocs. Postgres FTS prefilters by
// `tsv @@ plainto_tsquery('english', …)`, so a German or synonym query can
// return ZERO lexical candidates — reranking those would change nothing.
// To recover the gap we score a bounded full-scope candidate set by query↔
// chunk cosine similarity (semantic recall, multilingual) and lead with it;
// FTS hits then fill the remainder so a lexically-relevant chunk without an
// embedding (pre-backfill) is never dropped.
//
// No pgvector: the scan is bounded (the caller caps how many chunk vectors
// it fetches) and the cosine runs in JS, so this works on stock Postgres.

import { cosineSimilarity, embeddingsAvailable, embedText } from "./local-provider.ts";

/** Cosine floor for vector-only inclusion. Below this a chunk is too
 *  dissimilar to surface on semantics alone — keeps the recall net clean. */
export const VECTOR_MIN_COSINE = 0.3;

export interface ScoredCandidate<T> {
  item: T;
  cosine: number;
}

/** Injectable for deterministic tests; defaults to the local model. */
export interface QueryEmbedder {
  available(): Promise<boolean>;
  embed(text: string): Promise<number[] | null>;
}

const localQueryEmbedder: QueryEmbedder = {
  available: embeddingsAvailable,
  embed: embedText,
};

/**
 * Score candidates by cosine similarity to the query; keep those at/above
 * the floor, sorted best-first. Returns `[]` when embeddings are
 * unavailable, the query is empty, or no candidate clears the floor — so
 * the caller cleanly degrades to pure FTS.
 */
export async function vectorScoreCandidates<T>(
  query: string,
  candidates: Array<{ item: T; embedding: number[] | null }>,
  opts: { minCosine?: number; embedder?: QueryEmbedder } = {},
): Promise<ScoredCandidate<T>[]> {
  const embedder = opts.embedder ?? localQueryEmbedder;
  const minCosine = opts.minCosine ?? VECTOR_MIN_COSINE;
  if (!query.trim() || candidates.length === 0) return [];
  if (!(await embedder.available())) return [];
  const qVec = await embedder.embed(query);
  if (!qVec) return [];
  const scored: ScoredCandidate<T>[] = [];
  for (const c of candidates) {
    if (!c.embedding || c.embedding.length === 0) continue;
    const cosine = cosineSimilarity(qVec, c.embedding);
    if (cosine >= minCosine) scored.push({ item: c.item, cosine });
  }
  scored.sort((a, b) => b.cosine - a.cosine);
  return scored;
}

/**
 * Vector-first fusion with an FTS recall safety net. Vector hits lead
 * (semantic precision + multilingual recovery); FTS hits fill the
 * remainder. Dedup by id; truncate to `limit`. When `vector` is empty this
 * returns the FTS order unchanged — i.e. exactly today's behaviour.
 */
export function fuseVectorFirst<T>(opts: {
  fts: T[];
  vector: ScoredCandidate<T>[];
  idOf: (t: T) => string;
  limit: number;
}): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of opts.vector) {
    const id = opts.idOf(v.item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(v.item);
    if (out.length >= opts.limit) return out;
  }
  for (const f of opts.fts) {
    const id = opts.idOf(f);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(f);
    if (out.length >= opts.limit) return out;
  }
  return out;
}
