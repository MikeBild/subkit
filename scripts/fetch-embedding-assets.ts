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

// HF path (relative to HF_BASE) -> local filename + a minimum plausible size
// so a truncated/HTML-error download is re-fetched rather than embedded. The
// config/tokenizer files are saved with a `.bin` extension on purpose: their
// `with { type: "file" }` import in embedded-assets.ts must resolve against an
// ambient `*.bin` declaration (an opaque path string), NOT TypeScript's
// `resolveJsonModule`, which would demand the real file at typecheck time —
// before this script has fetched it in CI.
const MODEL_FILES: Array<{ remote: string; local: string; minBytes: number }> = [
  { remote: "config.json", local: "config.bin", minBytes: 100 },
  { remote: "tokenizer.json", local: "tokenizer.bin", minBytes: 1_000_000 },
  { remote: "tokenizer_config.json", local: "tokenizer_config.bin", minBytes: 100 },
  { remote: "special_tokens_map.json", local: "special_tokens_map.bin", minBytes: 50 },
  { remote: "onnx/model_quantized.onnx", local: "model_quantized.onnx", minBytes: 50_000_000 },
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

/** Is this failure worth trying again, or is it an answer?
 *
 *  A dropped socket, a reset, a 5xx or a 429 say nothing about the request —
 *  only about the moment. A 404 or a 403 is the server's verdict and retrying
 *  it just fails slower. The short-read case counts as transient on purpose:
 *  a truncated body is exactly what a half-closed connection produces, and it
 *  is indistinguishable from one at this layer. */
export function isTransient(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /socket connection was closed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|Unable to connect|fetch failed/i.test(
      message,
    ) ||
    / -> (408|429|5\d\d) /.test(message) ||
    /returned \d+ bytes/.test(message)
  );
}

/** Fetch one asset, retrying the failures that are about the network rather
 *  than about the URL.
 *
 *  This runs inside the Docker build, where an unretried fetch is a single
 *  point of failure for the whole image: a dropped socket on one of five files
 *  failed the v6.0.2 `docker-publish` outright. The same class already bit the
 *  cross-compile toolchain download. Nothing here is cached between attempts,
 *  so a retry is a clean second try — there is no corrupt artifact to purge as
 *  there is for the bun runtime. */
export async function download(
  url: string,
  dest: string,
  minBytes: number,
  // Injected so the retry LOOP can be exercised without a network. The
  // classifier being right is not the same as the loop calling it — the
  // release that broke here had no loop at all.
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText} `);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < minBytes) {
        throw new Error(`GET ${url} returned ${buf.byteLength} bytes (< ${minBytes} expected)`);
      }
      await ensureDir(dirname(dest));
      await Bun.write(dest, buf);
      return;
    } catch (err) {
      if (attempt === attempts || !isTransient(err)) throw err;
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.log(
        `  ! ${url} failed (attempt ${attempt}/${attempts}): ${
          err instanceof Error ? err.message : String(err)
        } — retrying in ${backoffMs}ms`,
      );
      await sleep(backoffMs);
    }
  }
}

async function main(): Promise<void> {
  await ensureDir(MINILM_DIR);
  await ensureDir(ORT_DIR);

  for (const f of MODEL_FILES) {
    const dest = join(MINILM_DIR, f.local);
    if (ok(dest, f.minBytes)) {
      console.log(`  ✓ ${f.local} (cached)`);
      continue;
    }
    console.log(`  ↓ ${f.local} …`);
    await download(`${HF_BASE}/${f.remote}`, dest, f.minBytes);
    console.log(`  ✓ ${f.local} (${(Bun.file(dest).size / 1e6).toFixed(1)} MB)`);
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

// Guarded so the module can be imported for its exported helpers without
// downloading ~90 MB of model weights as a side effect.
if (import.meta.main) await main();
