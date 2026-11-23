import { cosineSimilarity, embeddingsAvailable, embedText } from "./local-provider.ts";

export const VECTOR_MIN_COSINE = 0.3;

interface ScoredCandidate<T> {
  item: T;
  cosine: number;
}

export interface QueryEmbedder {
  available(): Promise<boolean>;
  embed(text: string): Promise<number[] | null>;
}

const localQueryEmbedder: QueryEmbedder = {
  available: embeddingsAvailable,
  embed: embedText,
};

export async function embedQuery(
  query: string,
  embedder: QueryEmbedder = localQueryEmbedder,
): Promise<number[] | null> {
  if (!query.trim()) return null;
  if (!(await embedder.available())) return null;
  return embedder.embed(query);
}

export async function vectorScoreCandidates<T>(
  query: string,
  candidates: Array<{ item: T; embedding: number[] | null }>,
  opts: { minCosine?: number; embedder?: QueryEmbedder } = {},
): Promise<ScoredCandidate<T>[]> {
  const embedder = opts.embedder ?? localQueryEmbedder;
  const minCosine = opts.minCosine ?? VECTOR_MIN_COSINE;
  if (candidates.length === 0) return [];
  const qVec = await embedQuery(query, embedder);
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
