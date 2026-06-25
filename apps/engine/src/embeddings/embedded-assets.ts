// Embedded MiniLM assets — inlined into the `bun build --compile` binary.
//
// Each `with { type: "file" }` import resolves to a STRING path that Bun
// serves from the binary's virtual filesystem (/$bunfs/...) at runtime, so
// the deployed engine carries the model, tokenizer and onnxruntime-web WASM
// inside itself — no model download, no API key, no query-time egress.
//
// The bytes are NOT committed (too large); `scripts/fetch-embedding-assets.ts`
// populates ../../assets/embeddings/ before the compile step. This module is
// imported DYNAMICALLY (see local-provider.ts) so `bun run`/`bun test` —
// which never run the fetch — fail to resolve these imports gracefully and
// fall back to FTS, while the compiled build embeds them.

import configJson from "../../assets/embeddings/minilm/config.json" with { type: "file" };
import modelOnnx from "../../assets/embeddings/minilm/model_quantized.onnx" with { type: "file" };
import specialTokensJson from "../../assets/embeddings/minilm/special_tokens_map.json" with {
  type: "file",
};
import tokenizerJson from "../../assets/embeddings/minilm/tokenizer.json" with { type: "file" };
import tokenizerConfigJson from "../../assets/embeddings/minilm/tokenizer_config.json" with {
  type: "file",
};
import ortMjs from "../../assets/embeddings/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs" with {
  type: "file",
};
import ortWasm from "../../assets/embeddings/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm" with {
  type: "file",
};

/** Embedded onnxruntime-web glue + wasm paths (bunfs-resolvable). */
export const ORT_ASSETS = { mjs: ortMjs, wasm: ortWasm } as const;

// The .json imports carry the `type: "file"` attribute, so Bun resolves them
// to a path STRING at runtime — but TypeScript's resolveJsonModule types them
// as the parsed object. Coerce the binding type back to the runtime reality.
const asPath = (file: unknown): string => file as string;

/** Embedded model-file paths keyed by their HuggingFace basename — the key
 *  the env.fetch shim matches the requested URL against. */
export const MODEL_FILE_BY_BASENAME: Readonly<Record<string, string>> = {
  "model_quantized.onnx": modelOnnx,
  "config.json": asPath(configJson),
  "tokenizer.json": asPath(tokenizerJson),
  "tokenizer_config.json": asPath(tokenizerConfigJson),
  "special_tokens_map.json": asPath(specialTokensJson),
};
