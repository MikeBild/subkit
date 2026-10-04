import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const MINILM_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/minilm");
const ORT_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/onnxruntime");
const ORT_SRC = join(REPO_ROOT, "node_modules/onnxruntime-web/dist");

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const REVISION = "main";
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}`;

const MODEL_FILES: Array<{ remote: string; local: string; minBytes: number }> = [
  { remote: "config.json", local: "config.bin", minBytes: 100 },
  { remote: "tokenizer.json", local: "tokenizer.bin", minBytes: 1_000_000 },
  { remote: "tokenizer_config.json", local: "tokenizer_config.bin", minBytes: 100 },
  { remote: "special_tokens_map.json", local: "special_tokens_map.bin", minBytes: 50 },
  { remote: "onnx/model_quantized.onnx", local: "model_quantized.onnx", minBytes: 50_000_000 },
];

const ORT_FILES = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

function ok(path: string, minBytes: number): boolean {
  if (!existsSync(path)) return false;
  return Bun.file(path).size >= minBytes;
}

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

export async function download(
  url: string,
  dest: string,
  minBytes: number,
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

if (import.meta.main) await main();
