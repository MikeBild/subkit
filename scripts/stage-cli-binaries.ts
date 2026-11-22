import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_TARGETS,
  cliAssetName,
  type ReleaseTarget,
} from "../packages/cli-core/src/release/assets.ts";
import { buildClipper } from "./build-clipper.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "apps/subkit/src/index.ts");
const DEFAULT_DIR = "/usr/local/share/subkit/binaries";

interface StageTarget extends ReleaseTarget {
  bunTarget: string;
}

export const STAGE_TARGETS: readonly StageTarget[] = CLI_TARGETS.map((target) => ({
  ...target,
  bunTarget: `bun-${target.os}-${target.arch}`,
}));

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
  target: StageTarget,
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

async function compileTarget(target: StageTarget, outFile: string, version: string): Promise<void> {
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

export type DarwinSigner = "codesign-script" | "rcodesign";

export function darwinSigner(hostPlatform: string, rcodesignPath: string | null): DarwinSigner {
  if (hostPlatform === "darwin") return "codesign-script";
  if (rcodesignPath) return "rcodesign";
  throw new Error(
    `cannot ad-hoc sign macOS binaries on ${hostPlatform}: rcodesign not found (set RCODESIGN or run scripts/install-rcodesign.ts)`,
  );
}

export function hasAdHocSignature(signatureInfo: string): boolean {
  return /adhoc/i.test(signatureInfo);
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out + err };
}

async function signDarwinBinary(file: string): Promise<void> {
  const rcodesign = process.env.RCODESIGN || Bun.which("rcodesign");
  const signer = darwinSigner(process.platform, rcodesign ?? null);
  if (signer === "codesign-script") {
    const signed = await run(["sh", join(REPO_ROOT, "scripts/codesign-macos.sh"), file]);
    if (signed.code !== 0) throw new Error(`codesign failed for ${file}: ${signed.out}`);
    return;
  }
  const tmp = `${file}.signed`;
  const signed = await run([rcodesign as string, "sign", file, tmp]);
  if (signed.code !== 0) throw new Error(`rcodesign sign failed for ${file}: ${signed.out}`);
  await rename(tmp, file);
  await chmod(file, 0o755);
  const info = await run([rcodesign as string, "print-signature-info", file]);
  if (info.code !== 0 || !hasAdHocSignature(info.out)) {
    throw new Error(`${file} does not carry an ad-hoc signature after signing: ${info.out}`);
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

  console.log(`staging subkit ${version} → ${dir}`);
  const sumsLines: string[] = [];
  for (const target of STAGE_TARGETS) {
    const filename = cliAssetName(target);
    const outFile = join(dir, filename);
    console.log(`  building ${filename} (${target.bunTarget})`);
    await compileTarget(target, outFile, version);
    if (target.os === "darwin") {
      console.log(`  signing ${filename}`);
      await signDarwinBinary(outFile);
    }
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
