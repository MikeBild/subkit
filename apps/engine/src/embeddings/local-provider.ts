// Local embedding provider — in-process multilingual sentence embeddings.
//
// subkit's retrieval (knowledge, connector docs, connector-template
// matching) is Postgres FTS today: lexical, English-stemmer only. Measured
// evidence (benchmarks/retrieval) shows the template path lands the right
// connector on natural-language intent 0% of the time and is essentially
// blind to German. Semantic vector retrieval closes that gap.
//
// We embed locally with a multilingual MiniLM (q8) whose model, tokenizer
// and onnxruntime-web WASM are EMBEDDED into the compiled binary
// (embedded-assets.ts) — so the deployed engine produces embeddings with no
// API key, no per-call cost and no query-time egress. The model is
// mean-pooled + L2-normalised, so a plain dot product equals cosine
// similarity. It is loaded lazily and once per process — boot stays cheap;
// the first retrieval/ingest that needs an embedding pays the load (or boot
// warms it, see warmEmbeddings).
//
// Why the WASM build and the small dance below: `bun build --compile`
// embeds a native `.node` addon but NOT its companion `libonnxruntime.so`,
// so the default onnxruntime-node backend dlopen-fails in the deployed
// binary. transformers.js's web build (transformers.web.js) runs purely on
// onnxruntime-web (WASM) — no native lib — and the binary stays
// self-contained. The provider remains best-effort and degradable: callers
// fall back to FTS when embeddings are unavailable, so a load failure (e.g.
// assets not fetched in a dev/test build) never breaks retrieval.

import { logger } from "../logging/logger.ts";

/** Model id + geometry. Pinned here as the single source of truth — the
 *  pgvector column dimension and any stored `embedding_model` tag must
 *  match these, so a model swap is a deliberate, migration-bearing change.
 *  The dtype must match the embedded model file (model_quantized.onnx). */
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
const EMBEDDING_DTYPE = "q8";

// The web build is imported via its dist file: the package `exports` map
// resolves the bare specifier to the native (`node` condition) build, and
// there is no public subpath for the web build, so we reference the file
// directly. Relative to this module (apps/engine/src/embeddings/) the
// hoisted root node_modules is four levels up. The dynamic import() below
// MUST take this as a string literal, not a variable — `bun build --compile`
// only bundles dynamic imports whose specifier it can resolve statically.

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

interface TransformersWeb {
  pipeline: (task: string, model: string, opts?: { dtype?: string }) => Promise<Extractor>;
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    useWasmCache?: boolean;
    fetch?: (input: unknown) => Promise<Response>;
    backends?: { onnx?: { wasm?: { numThreads?: number; wasmPaths?: unknown } } };
  };
}

let extractorPromise: Promise<Extractor | null> | null = null;

/** Import the WASM transformers build with onnxruntime-web wired to the
 *  embedded model + wasm assets, instead of fetching anything from the
 *  network or a native runtime. */
async function importWebBuild(): Promise<TransformersWeb> {
  const { ORT_ASSETS, MODEL_FILE_BY_BASENAME } = await import("./embedded-assets.ts");

  // transformers.js decides whether to return the onnx model as a FILE PATH
  // (needs node:fs) vs an in-memory BUFFER from `apis.IS_NODE_ENV`, captured
  // at module-eval from `process.release.name === "node"`. The web build
  // stubs out node:fs, so the path branch dead-ends ("Unable to get model
  // file path or buffer"). Under bun-compiled, node-detected-but-no-fs is
  // the wrong signal; we correct it for the one-time module eval so the
  // model loads as a buffer, then restore it immediately (nothing else in
  // the engine reads process.release). Boot warms this before traffic, so
  // the restore window is never observed by a concurrent request.
  const release = process.release as { name?: string };
  const realName = release.name;
  Object.defineProperty(process.release, "name", { value: "bun-embed", configurable: true });
  let mod: TransformersWeb;
  try {
    mod = (await import(
      // @ts-expect-error — the web build dist file ships no type declarations;
      // its shape is asserted via the TransformersWeb interface below.
      "../../../../node_modules/@huggingface/transformers/dist/transformers.web.js"
    )) as unknown as TransformersWeb;
  } finally {
    Object.defineProperty(process.release, "name", { value: realName, configurable: true });
  }

  const { env } = mod;
  // allowRemoteModels=true makes transformers build HuggingFace URLs; the
  // fetch shim below answers them from the embedded bytes (nothing leaves
  // the process). allowLocalModels=false avoids the dead node:fs path.
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useWasmCache = false;
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = 1; // compiled binary has no worker threads
    wasm.wasmPaths = { mjs: ORT_ASSETS.mjs, wasm: ORT_ASSETS.wasm };
  }
  env.fetch = async (input: unknown): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : ((input as { url?: string } | null)?.url ?? String(input));
    const basename = url.split("?")[0]!.split("/").pop() ?? "";
    const file = MODEL_FILE_BY_BASENAME[basename];
    if (file) {
      const buf = await Bun.file(file).arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: { "content-length": String(buf.byteLength) },
      });
    }
    return new Response(null, { status: 404 });
  };
  return mod;
}

async function loadExtractor(): Promise<Extractor | null> {
  try {
    const { pipeline } = await importWebBuild();
    const t0 = Date.now();
    const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: EMBEDDING_DTYPE,
    });
    logger.info({
      module: "embeddings",
      action: "model.loaded",
      msg: "local embedding model loaded (embedded WASM)",
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

/** Trigger the (one-time) model load. Call during boot, before the HTTP
 *  listener accepts traffic, so the first retrieval is warm and the
 *  process.release dance in importWebBuild() runs with no concurrency. */
export async function warmEmbeddings(): Promise<boolean> {
  return embeddingsAvailable();
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

/** Max texts handed to the WASM extractor in one synchronous call on the
 *  backfill path. One MiniLM forward pass is tens of ms, so ~4 texts keeps a
 *  single block well under the ~100-200ms event-loop budget. */
export const EMBED_SUBBATCH = 4;

/** Yield a *macrotask* so the event loop runs pending I/O and timers (health
 *  checks, HTTP handlers) before the next synchronous WASM block. A microtask
 *  (Promise.resolve) would NOT — it drains before the loop services I/O. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Paced variant of embedChunkTexts for the bulk backfill path. Splits `texts`
 * into sub-batches of `subBatch` (default EMBED_SUBBATCH) and embeds each via
 * embedChunkTexts, yielding a macrotask between sub-batches so the event loop
 * stays responsive while a backlog drains. Output is null-aligned to the input.
 * Never throws — same contract as embedChunkTexts. `embed`/`yield` are
 * injectable so tests assert pacing without a real model.
 */
export async function embedChunkTextsPaced(
  texts: string[],
  opts: {
    subBatch?: number;
    embed?: (t: string[]) => Promise<(number[] | null)[]>;
    yield?: () => Promise<void>;
  } = {},
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const subBatch = Math.max(1, opts.subBatch ?? EMBED_SUBBATCH);
  const embed = opts.embed ?? embedChunkTexts;
  const onYield = opts.yield ?? yieldToEventLoop;
  const out: (number[] | null)[] = [];
  for (let i = 0; i < texts.length; i += subBatch) {
    if (i > 0) await onYield(); // macrotask between blocks, not before the first
    const slice = texts.slice(i, i + subBatch);
    out.push(...(await embed(slice)));
  }
  return out;
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
