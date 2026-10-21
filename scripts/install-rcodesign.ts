import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RCODESIGN_VERSION = "0.29.0";

export const RCODESIGN_SHA256: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002",
  "aarch64-unknown-linux-musl": "4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f",
  "aarch64-apple-darwin": "d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a",
  "x86_64-apple-darwin": "14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140",
};

export function resolveRcodesignTarget(platform: string, arch: string): string {
  const key = `${platform}/${arch}`;
  switch (key) {
    case "linux/x64":
      return "x86_64-unknown-linux-musl";
    case "linux/arm64":
      return "aarch64-unknown-linux-musl";
    case "darwin/arm64":
      return "aarch64-apple-darwin";
    case "darwin/x64":
      return "x86_64-apple-darwin";
    default:
      throw new Error(`no pinned rcodesign archive for ${key}`);
  }
}

export function rcodesignArchiveName(target: string): string {
  return `apple-codesign-${RCODESIGN_VERSION}-${target}`;
}

export function rcodesignArchiveUrl(target: string): string {
  return `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${rcodesignArchiveName(target)}.tar.gz`;
}

export function verifyArchiveChecksum(target: string, bytes: Uint8Array): void {
  const expected = RCODESIGN_SHA256[target];
  if (!expected) throw new Error(`no pinned checksum for rcodesign target ${target}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `rcodesign archive checksum mismatch for ${target}: expected ${expected}, got ${actual}`,
    );
  }
}

export async function installRcodesign(outDir: string): Promise<string> {
  const target = resolveRcodesignTarget(process.platform, process.arch);
  const url = rcodesignArchiveUrl(target);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of ${url} failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  verifyArchiveChecksum(target, bytes);

  const work = await mkdtemp(join(tmpdir(), "rcodesign-"));
  try {
    const archive = join(work, "rcodesign.tar.gz");
    await writeFile(archive, bytes);
    const proc = Bun.spawn(["tar", "-xzf", archive, "-C", work], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await proc.exited) !== 0) throw new Error("tar extraction of rcodesign failed");
    await mkdir(outDir, { recursive: true });
    const dest = join(outDir, "rcodesign");
    await copyFile(join(work, rcodesignArchiveName(target), "rcodesign"), dest);
    await chmod(dest, 0o755);
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const outDir = Bun.argv[2];
  if (!outDir) {
    console.error("usage: bun scripts/install-rcodesign.ts <output-dir>");
    process.exit(1);
  }
  installRcodesign(outDir)
    .then((path) => console.log(path))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
