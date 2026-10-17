import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import manifest from "../vendor/embedding-assets.json";

const REPO_ROOT = join(import.meta.dir, "..");
const MINILM_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/minilm");
const ORT_DIR = join(REPO_ROOT, "apps/engine/assets/embeddings/onnxruntime");
const ORT_SRC = join(REPO_ROOT, "node_modules/onnxruntime-web/dist");

export interface AssetDigest {
  bytes: number;
  sha256: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function matchesAsset(path: string, expected: AssetDigest): Promise<boolean> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size !== expected.bytes) return false;
  return digest(new Uint8Array(await file.arrayBuffer())) === expected.sha256;
}

async function writeAtomically(dest: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const temporary = await mkdtemp(join(dirname(dest), ".embedding-"));
  try {
    const candidate = join(temporary, "asset");
    await writeFile(candidate, bytes);
    await rename(candidate, dest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertAsset(bytes: Uint8Array, expected: AssetDigest, source: string): void {
  if (bytes.length !== expected.bytes) {
    throw new Error(`${source} returned ${bytes.length} bytes (expected ${expected.bytes})`);
  }
  if (digest(bytes) !== expected.sha256) throw new Error(`${source}: asset checksum mismatch`);
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
  expected: AssetDigest,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`GET ${url} -> ${response.status} ${response.statusText} `);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertAsset(bytes, expected, `GET ${url}`);
      await writeAtomically(dest, bytes);
      return;
    } catch (err) {
      if (attempt === attempts || !isTransient(err)) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

export async function copyRuntimeAsset(
  source: string,
  dest: string,
  expected: AssetDigest,
): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
  assertAsset(bytes, expected, source);
  if (await matchesAsset(dest, expected)) return;
  await writeAtomically(dest, bytes);
}

async function main(): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(manifest.revision)) {
    throw new Error("Embedding model requires an immutable revision");
  }
  const base = `https://huggingface.co/${manifest.model}/resolve/${manifest.revision}`;
  for (const asset of manifest.files) {
    const dest = join(MINILM_DIR, asset.local);
    if (!(await matchesAsset(dest, asset))) {
      await download(`${base}/${asset.remote}`, dest, asset);
    }
  }
  for (const asset of manifest.runtime) {
    await copyRuntimeAsset(join(ORT_SRC, asset.name), join(ORT_DIR, asset.name), asset);
  }
  console.log("embedding assets verified");
}

if (import.meta.main) await main();
