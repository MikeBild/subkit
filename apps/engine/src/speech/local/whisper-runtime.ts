import { join } from "node:path";
import { LOCAL_SPEECH_MODEL, modelFileForUrl } from "../core/model-files.ts";

type Recognizer = (
  samples: Float32Array,
  options: {
    chunk_length_s: number;
    stride_length_s: number;
    return_timestamps: false;
    task: "transcribe";
    language?: string;
  },
) => Promise<{ text: string } | { text: string }[]>;

interface TransformersWeb {
  pipeline: (
    task: string,
    model: string,
    options?: { dtype?: string; session_options?: { graphOptimizationLevel?: string } },
  ) => Promise<Recognizer>;
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    useWasmCache?: boolean;
    fetch?: (input: unknown) => Promise<Response>;
    backends?: { onnx?: { wasm?: { numThreads?: number; wasmPaths?: unknown } } };
  };
}

const recognizers = new Map<string, Promise<Recognizer>>();

async function importWebBuild(dir: string): Promise<TransformersWeb> {
  const { importTransformersWeb, onnxRuntimeAssets } = await import("../../embeddings/index.ts");
  const ORT_ASSETS = await onnxRuntimeAssets();
  const transformers = await importTransformersWeb<TransformersWeb>();
  const { env } = transformers;
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
    const file = modelFileForUrl(url);
    if (!file) return new Response(null, { status: 404 });
    const buffer = await Bun.file(join(dir, file.path)).arrayBuffer();
    return new Response(buffer, {
      status: 200,
      headers: { "content-length": String(buffer.byteLength) },
    });
  };
  return transformers;
}

function recognizerFor(dir: string): Promise<Recognizer> {
  const existing = recognizers.get(dir);
  if (existing) return existing;
  const loading = (async () => {
    const { pipeline } = await importWebBuild(dir);
    return pipeline("automatic-speech-recognition", LOCAL_SPEECH_MODEL, {
      dtype: "q8",
      session_options: { graphOptimizationLevel: "basic" },
    });
  })();
  loading.catch(() => recognizers.delete(dir));
  recognizers.set(dir, loading);
  return loading;
}

export async function transcribeSamples(
  dir: string,
  samples: Float32Array,
  language?: string,
): Promise<string> {
  const recognize = await recognizerFor(dir);
  const output = await recognize(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
    task: "transcribe",
    ...(language ? { language } : {}),
  });
  return Array.isArray(output) ? output.map((part) => part.text).join(" ") : output.text;
}
