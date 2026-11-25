import { logger } from "../logging/index.ts";

export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const EMBEDDING_DIM = 384;
const EMBEDDING_DTYPE = "q8";
const MAX_EMBEDDING_INPUT_CHARS = 8192;

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

export async function importTransformersWeb<T>(): Promise<T> {
  const release = process.release as { name?: string };
  const realName = release.name;
  Object.defineProperty(process.release, "name", { value: "bun-embed", configurable: true });
  try {
    return (await import(
      // @ts-expect-error — the web build dist file ships no type declarations;
      // its shape is asserted via the TransformersWeb interface below.
      "../../../../node_modules/@huggingface/transformers/dist/transformers.web.js"
    )) as unknown as T;
  } finally {
    Object.defineProperty(process.release, "name", { value: realName, configurable: true });
  }
}

async function importWebBuild(): Promise<TransformersWeb> {
  const { ORT_ASSETS, MODEL_FILE_BY_BASENAME } = await import("./embedded-assets.ts");
  const mod = await importTransformersWeb<TransformersWeb>();
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

export async function embeddingsAvailable(): Promise<boolean> {
  if (!extractorPromise) extractorPromise = loadExtractor();
  return (await extractorPromise) !== null;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!extractorPromise) extractorPromise = loadExtractor();
  const extractor = await extractorPromise;
  if (!extractor) return [];
  const out = await extractor(
    texts.map((text) => text.slice(0, MAX_EMBEDDING_INPUT_CHARS)),
    { pooling: "mean", normalize: true },
  );
  return out.tolist();
}
