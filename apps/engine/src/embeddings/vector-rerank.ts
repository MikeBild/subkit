import { cosineSimilarity, embeddingsAvailable, embedText } from "./local-provider.ts";

export const VECTOR_MIN_COSINE = 0.3;

export interface ScoredCandidate<T> {
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
