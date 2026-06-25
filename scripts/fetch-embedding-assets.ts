// Fetch the embedded-embedding assets that `bun build --compile` inlines
// into the engine binary (see apps/engine/src/embeddings/embedded-assets.ts).
//
// The engine ships a fully self-contained multilingual MiniLM: model +
// tokenizer + onnxruntime-web WASM are embedded into the single binary, so
// the deployed engine produces semantic embeddings with NO API key, NO
// per-call cost and NO network egress. Those asset bytes are too large to
// commit, so the compiled build fetches them first via this script.
//
//   - The MiniLM files are downloaded from the HuggingFace CDN (pinned model
//     id + revision) into apps/engine/assets/embeddings/minilm/.
//   - The onnxruntime-web WASM runtime is COPIED out of node_modules so its
//     version always matches the installed onnxruntime-web (a mismatch would
//     fail model init at runtime).
//
// Idempotent: a file already present at its expected byte size is left
// alone, so repeat builds and local dev pay the ~146 MB download once.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const MINILM_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/minilm");
const ORT_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/onnxruntime");
const ORT_SRC = join(REPO_ROOT, "node_modules/onnxruntime-web/dist");

// Pinned model + revision — must match EMBEDDING_MODEL in local-provider.ts.
const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const REVISION = "main";
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}`;

// filename -> HF path (relative to HF_BASE) + a minimum plausible size so a
// truncated/HTML-error download is re-fetched rather than embedded.
const MODEL_FILES: Array<{ name: string; remote: string; minBytes: number }> = [
  { name: "config.json", remote: "config.json", minBytes: 100 },
  { name: "tokenizer.json", remote: "tokenizer.json", minBytes: 1_000_000 },
  { name: "tokenizer_config.json", remote: "tokenizer_config.json", minBytes: 100 },
  { name: "special_tokens_map.json", remote: "special_tokens_map.json", minBytes: 50 },
  { name: "model_quantized.onnx", remote: "onnx/model_quantized.onnx", minBytes: 50_000_000 },
];

// onnxruntime-web emscripten glue + wasm (asyncify variant — the non-Safari
// default transformers.js selects). Copied from node_modules so the version
// matches exactly.
const ORT_FILES = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

function ok(path: string, minBytes: number): boolean {
  if (!existsSync(path)) return false;
  return Bun.file(path).size >= minBytes;
}

async function download(url: string, dest: string, minBytes: number): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < minBytes) {
    throw new Error(`GET ${url} returned ${buf.byteLength} bytes (< ${minBytes} expected)`);
  }
  await ensureDir(dirname(dest));
  await Bun.write(dest, buf);
}

async function main(): Promise<void> {
  await ensureDir(MINILM_DIR);
  await ensureDir(ORT_DIR);

  for (const f of MODEL_FILES) {
    const dest = join(MINILM_DIR, f.name);
    if (ok(dest, f.minBytes)) {
      console.log(`  ✓ ${f.name} (cached)`);
      continue;
    }
    console.log(`  ↓ ${f.name} …`);
    await download(`${HF_BASE}/${f.remote}`, dest, f.minBytes);
    console.log(`  ✓ ${f.name} (${(Bun.file(dest).size / 1e6).toFixed(1)} MB)`);
  }

  for (const name of ORT_FILES) {
    const src = join(ORT_SRC, name);
    const dest = join(ORT_DIR, name);
    if (!existsSync(src)) {
      throw new Error(
        `onnxruntime-web asset missing at ${src} — run \`bun install\` before building`,
      );
    }
    const srcSize = Bun.file(src).size;
    if (ok(dest, srcSize)) {
      console.log(`  ✓ ${name} (in sync)`);
      continue;
    }
    await Bun.write(dest, Bun.file(src));
    console.log(`  ✓ ${name} (${(srcSize / 1e6).toFixed(1)} MB, copied)`);
  }

  console.log("embedding assets ready");
}

await main();
