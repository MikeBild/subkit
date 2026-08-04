// Cross-compile the `sk` CLI for every supported client platform and stage
// the binaries + a SHA256SUMS manifest into the directory the engine serves
// via `GET /install/{asset}` (SUBKIT_BINARIES_DIR, default
// /usr/local/share/subkit/binaries).
//
// WHY: an operator's running engine is the one supported source for the CLI —
// `curl -fsSL <engine-url>/install | bash` probes `<engine-url>/install/sk-
// <os>-<arch>` first (see apps/engine/src/http/routes/install.ts). For that to
// return 200 for ANY client (a mac dev talking to a linux engine, etc.), the
// engine must hold all five platform binaries. The GitHub Release fallback in
// the install script points at a PRIVATE repo, so it is a dead end for real
// users — this staging step removes that dependency by building the binaries
// straight from this repo's source, no github.com egress required.
//
// Reused by the Dockerfile (builder stage) and by the production deploy so the
// on-disk names + SHA256SUMS format are produced in exactly one place and can
// never drift from what install-binary.ts::parseAsset/diskFilename expects.
//
// Usage:
//   bun scripts/stage-cli-binaries.ts [--dir <out>] [--version <v>]
// Defaults: --dir /usr/local/share/subkit/binaries; version from package.json.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "apps/sk/src/index.ts");
const DEFAULT_DIR = "/usr/local/share/subkit/binaries";

// The five client platforms the release matrix builds and install-binary.ts
// serves. windows-arm64 is intentionally absent — parseAsset rejects it.
const TARGETS = [
  { os: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
  { os: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { os: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { os: "windows", arch: "x64", bunTarget: "bun-windows-x64" },
] as const;

// On-disk artifact names use underscores and a `.exe` suffix on Windows —
// this MUST match install-binary.ts::diskFilename so the served asset resolves.
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

/** A cross-compile needs the TARGET platform's bun runtime, which `bun build`
 *  downloads and caches itself. When that download is truncated the cache keeps
 *  the broken archive, so every later attempt fails the same way — which is how
 *  one bad fetch turned into four consecutive red nightlies. The message names
 *  the artifact, so the repair can be exact instead of clearing the whole cache:
 *
 *    Failed to extract executable for 'bun-linux-aarch64-v1.3.14'.
 *    The download may be incomplete.
 */
const CORRUPT_DOWNLOAD = /Failed to extract executable for '([^']+)'/i;

/** Which cached runtime did the compiler blame? Exported because this is the
 *  brittle part: it reads a message bun owns, and if the wording moves the
 *  repair silently stops happening and the failure goes back to permanent.
 *  A test holds the exact string. */
export function corruptRuntimeFromStderr(stderr: string): string | null {
  return CORRUPT_DOWNLOAD.exec(stderr)?.[1] ?? null;
}

function bunCacheDir(): string {
  const bunInstall = process.env.BUN_INSTALL || join(process.env.HOME ?? "", ".bun");
  return join(bunInstall, "install", "cache");
}

/** Drop the one cached runtime the error blamed. Returns whether anything was
 *  removed — a retry is only worth attempting if the broken input is gone. */
async function purgeCachedRuntime(stderr: string): Promise<string | null> {
  const named = corruptRuntimeFromStderr(stderr);
  if (!named) return null;
  const dir = join(bunCacheDir(), named);
  try {
    await rm(dir, { recursive: true, force: true });
    return dir;
  } catch {
    return null;
  }
}

async function runBunBuild(
  target: (typeof TARGETS)[number],
  outFile: string,
  version: string,
): Promise<{ code: number; stderr: string }> {
  // Mirror the flags used by package.json build:sk and release.yml exactly:
  //  - identity-define NODE_ENV so its build-time value is never inlined
  //  - stamp BUILD_VERSION as a quoted JS string literal
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      ENTRY,
      "--compile",
      `--target=${target.bunTarget}`,
      "--define",
      "process.env.NODE_ENV=process.env.NODE_ENV",
      "--define",
      `BUILD_VERSION="${version}"`,
      "--outfile",
      outFile,
    ],
    // stderr is captured so the corrupt-download signature can be read, then
    // re-emitted verbatim — a build log that swallows the compiler's own words
    // is worse than a flaky build.
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
  // One retry, and only after the corrupt artifact is actually gone. A blind
  // retry loop would paper over a genuine compile error and turn a clear
  // failure into a slow one.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { code, stderr } = await runBunBuild(target, outFile, version);
    if (code === 0) return;
    if (attempt === 2) {
      throw new Error(`bun build failed for ${target.bunTarget} (exit ${code})`);
    }
    const purged = await purgeCachedRuntime(stderr);
    if (!purged) {
      throw new Error(`bun build failed for ${target.bunTarget} (exit ${code})`);
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
  const { dir, version: explicitVersion } = parseArgs(Bun.argv.slice(2));
  const version = await resolveVersion(explicitVersion);
  await mkdir(dir, { recursive: true });

  // ssh2 ships an OPTIONAL cpu-features native addon that is never compiled;
  // `bun build --compile` chokes trying to bundle the missing .node. Strip it
  // first — mirrors package.json build:engine, release.yml, and the Dockerfile.
  await Bun.spawn(["rm", "-rf", join(REPO_ROOT, "node_modules/cpu-features")], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited;

  console.log(`staging sk ${version} → ${dir}`);
  // SHA256SUMS lines use the same `<hash>  <name>` (two-space) format as
  // `sha256sum` and the release workflow, so install-binary.ts's parser and
  // the install script's `grep`/`sha256sum -c` accept it unchanged.
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

// Guarded so the module can be imported for its exported helpers without
// staging binaries as a side effect — importing it used to start a real build
// and fail on `mkdir /usr/local/share/subkit`, which is why the corrupt-runtime
// signature had no test until now.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
