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
//
// The config/tokenizer files are stored with a `.bin` extension (not their
// real `.json`) so these imports resolve against the ambient `*.bin`
// declaration — an opaque path string — instead of TypeScript's
// resolveJsonModule, which would require the file to exist at typecheck time
// (it is fetched only at build time). Their byte content is unchanged; the
// shim keys them by the HuggingFace basename transformers.js requests.

import configBin from "../../assets/embeddings/minilm/config.bin" with { type: "file" };
import modelOnnx from "../../assets/embeddings/minilm/model_quantized.onnx" with { type: "file" };
import specialTokensBin from "../../assets/embeddings/minilm/special_tokens_map.bin" with {
  type: "file",
};
import tokenizerBin from "../../assets/embeddings/minilm/tokenizer.bin" with { type: "file" };
import tokenizerConfigBin from "../../assets/embeddings/minilm/tokenizer_config.bin" with {
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

/** Embedded model-file paths keyed by their HuggingFace basename — the key
 *  the env.fetch shim matches the requested URL against. */
export const MODEL_FILE_BY_BASENAME: Readonly<Record<string, string>> = {
  "model_quantized.onnx": modelOnnx,
  "config.json": configBin,
  "tokenizer.json": tokenizerBin,
  "tokenizer_config.json": tokenizerConfigBin,
  "special_tokens_map.json": specialTokensBin,
};
