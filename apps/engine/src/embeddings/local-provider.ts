// Local embedding provider — in-process multilingual sentence embeddings.
//
// subkit's retrieval (knowledge, connector docs, connector-template
// matching) is Postgres FTS today: lexical, English-stemmer only. Measured
// evidence (benchmarks/retrieval) shows the template path lands the right
// connector on natural-language intent 0% of the time and is essentially
// blind to German. Semantic vector retrieval closes that gap.
//
// We embed locally (no API key, no per-call cost, no egress at query time)
// with a multilingual MiniLM via transformers.js. The model is mean-pooled
// + L2-normalised, so a plain dot product equals cosine similarity. It is
// loaded lazily and once per process — boot stays cheap; the first
// retrieval/ingest that needs an embedding pays the load.
//
// Trade-off (accepted, see the embedding-provider decision): this adds an
// ONNX runtime + ~120MB model to the engine process. The provider is
// therefore best-effort and degradable — callers fall back to FTS when
// embeddings are unavailable, so a model-load failure never breaks
// retrieval.

import { logger } from "../logging/logger.ts";

/** Model id + geometry. Pinned here as the single source of truth — the
 *  pgvector column dimension and any stored `embedding_model` tag must
 *  match these, so a model swap is a deliberate, migration-bearing change. */
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;

// transformers.js is loaded dynamically so the (heavy) ONNX runtime is only
// pulled in when embeddings are actually used, and so the engine can boot
// even if the optional dependency is absent.
type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor | null> | null = null;

async function loadExtractor(): Promise<Extractor | null> {
  try {
    const { pipeline } = (await import("@huggingface/transformers")) as {
      pipeline: (task: string, model: string) => Promise<Extractor>;
    };
    const t0 = Date.now();
    const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL);
    logger.info({
      module: "embeddings",
      action: "model.loaded",
      msg: "local embedding model loaded",
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      duration_ms: Date.now() - t0,
    });
    return extractor;
  } catch (err) {
    logger.warn({
      module: "embeddings",
      action: "model.load_failed",
      msg: "local embedding model unavailable — retrieval falls back to FTS",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Whether embeddings are available this process (after a load attempt).
 *  Callers use this to decide between vector rerank and pure FTS. */
export async function embeddingsAvailable(): Promise<boolean> {
  if (!extractorPromise) extractorPromise = loadExtractor();
  return (await extractorPromise) !== null;
}

/**
 * Embed a batch of texts into L2-normalised vectors. Returns an empty
 * array when embeddings are unavailable (model failed to load) so callers
 * degrade to FTS rather than throw. Order matches the input.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!extractorPromise) extractorPromise = loadExtractor();
  const extractor = await extractorPromise;
  if (!extractor) return [];
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

/** Embed a single text. Returns null when embeddings are unavailable. */
export async function embedText(text: string): Promise<number[] | null> {
  const [vec] = await embedTexts([text]);
  return vec ?? null;
}

/**
 * Embed texts for storage, returning a null-aligned array (one entry per
 * input: the vector, or null when embeddings are unavailable or errored).
 * Never throws — ingest/backfill paths use this so a model outage stores no
 * vector rather than failing the write. The stored chunk stays reachable
 * via FTS and a later backfill fills the gap.
 */
export async function embedChunkTexts(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  try {
    const vecs = await embedTexts(texts);
    if (vecs.length === texts.length) return vecs;
  } catch {
    // fall through to nulls — never let embedding break an ingest
  }
  return texts.map(() => null);
}

/** Cosine similarity for L2-normalised vectors (i.e. a dot product).
 *  Defensive against non-normalised input so it is correct for any pair. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
