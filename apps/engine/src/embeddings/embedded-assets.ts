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

export const ORT_ASSETS = { mjs: ortMjs, wasm: ortWasm } as const;

export const MODEL_FILE_BY_BASENAME: Readonly<Record<string, string>> = {
  "model_quantized.onnx": modelOnnx,
  "config.json": configBin,
  "tokenizer.json": tokenizerBin,
  "tokenizer_config.json": tokenizerConfigBin,
  "special_tokens_map.json": specialTokensBin,
};
