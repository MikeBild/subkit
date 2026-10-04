import { logger } from "../logging/logger.ts";

export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
const EMBEDDING_DTYPE = "q8";

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

async function importWebBuild(): Promise<TransformersWeb> {
  const { ORT_ASSETS, MODEL_FILE_BY_BASENAME } = await import("./embedded-assets.ts");

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
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useWasmCache = false;
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = 1;
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

export async function warmEmbeddings(): Promise<boolean> {
  return embeddingsAvailable();
}

export async function embeddingsAvailable(): Promise<boolean> {
  if (!extractorPromise) extractorPromise = loadExtractor();
  return (await extractorPromise) !== null;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!extractorPromise) extractorPromise = loadExtractor();
  const extractor = await extractorPromise;
  if (!extractor) return [];
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  return out.tolist();
}

export async function embedText(text: string): Promise<number[] | null> {
  const [vec] = await embedTexts([text]);
  return vec ?? null;
}

export async function embedChunkTexts(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  try {
    const vecs = await embedTexts(texts);
    if (vecs.length === texts.length) return vecs;
  } catch {}
  return texts.map(() => null);
}

export const EMBED_SUBBATCH = 4;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
    if (i > 0) await onYield();
    const slice = texts.slice(i, i + subBatch);
    out.push(...(await embed(slice)));
  }
  return out;
}

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
