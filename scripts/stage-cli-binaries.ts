import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildClipper } from "./build-clipper.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "apps/sk/src/index.ts");
const DEFAULT_DIR = "/usr/local/share/subkit/binaries";

const TARGETS = [
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "windows", arch: "x64", bunTarget: "bun-windows-x64" },
] as const;

function diskFilename(os: string, arch: string): string {
  const ext = os === "windows" ? ".exe" : "";
  return `sk_${os}_${arch}${ext}`;
}

function parseArgs(argv: string[]): { dir: string; version?: string } {
  let dir = process.env.SUBKIT_BINARIES_DIR || DEFAULT_DIR;
  let version: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") dir = argv[++i] ?? dir;
    else if (a === "--version") version = argv[++i];
  }
  return { dir, version };
}

async function resolveVersion(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION;
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version as string;
}

const CORRUPT_DOWNLOAD = /Failed to extract executable for '([^']+)'/i;

export function corruptRuntimeFromStderr(stderr: string): string | null {
  return CORRUPT_DOWNLOAD.exec(stderr)?.[1] ?? null;
}

export function bunCacheDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    env.BUN_INSTALL_CACHE_DIR,
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "install", "cache") : undefined,
    env.HOME ? join(env.HOME, ".bun", "install", "cache") : undefined,
    "/root/.bun/install/cache",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return [...new Set(candidates)];
}

async function purgeCachedRuntime(stderr: string): Promise<string | null> {
  const named = corruptRuntimeFromStderr(stderr);
  if (!named) return null;
  for (const cacheDir of bunCacheDirCandidates()) {
    const dir = join(cacheDir, named);
    if (!existsSync(dir)) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      return dir;
    } catch {
      return null;
    }
  }
  return null;
}

async function runBunBuild(
  target: (typeof TARGETS)[number],
  outFile: string,
  version: string,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      ENTRY,
      "--compile",
      "--external",
      "cpu-features",
      `--target=${target.bunTarget}`,
      "--define",
      "process.env.NODE_ENV=process.env.NODE_ENV",
      "--define",
      `BUILD_VERSION="${version}"`,
      "--outfile",
      outFile,
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (stderr) process.stderr.write(stderr);
  return { code, stderr };
}

async function compileTarget(
  target: (typeof TARGETS)[number],
  outFile: string,
  version: string,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { code, stderr } = await runBunBuild(target, outFile, version);
    if (code === 0) return;
    if (attempt === 2) {
      throw new Error(`bun build failed for ${target.bunTarget} (exit ${code})`);
    }
    const purged = await purgeCachedRuntime(stderr);
    if (!purged) {
      const named = corruptRuntimeFromStderr(stderr);
      throw new Error(
        named
          ? `bun build failed for ${target.bunTarget} (exit ${code}): '${named}' is corrupt but no cache entry was found in ${bunCacheDirCandidates().join(", ")} — not retrying, the same download would fail again`
          : `bun build failed for ${target.bunTarget} (exit ${code})`,
      );
    }
    console.log(
      `[stage-cli-binaries] ${target.bunTarget}: cached runtime was corrupt, removed ${purged} — retrying once`,
    );
  }
}

async function sha256(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function main(): Promise<void> {
  await buildClipper();
  const { dir, version: explicitVersion } = parseArgs(Bun.argv.slice(2));
  const version = await resolveVersion(explicitVersion);
  await mkdir(dir, { recursive: true });

  console.log(`staging sk ${version} → ${dir}`);
  const sumsLines: string[] = [];
  for (const target of TARGETS) {
    const filename = diskFilename(target.os, target.arch);
    const outFile = join(dir, filename);
    console.log(`  building ${filename} (${target.bunTarget})`);
    await compileTarget(target, outFile, version);
    const hash = await sha256(outFile);
    sumsLines.push(`${hash}  ${filename}`);
  }

  const sumsPath = join(dir, "SHA256SUMS");
  await writeFile(sumsPath, `${sumsLines.join("\n")}\n`, "utf8");
  console.log(`wrote ${sumsPath}:`);
  console.log(sumsLines.map((l) => `  ${l}`).join("\n"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
