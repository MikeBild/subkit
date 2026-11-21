import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileCommand, ENGINE_ENTRIES } from "./lib/commands.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_OUT = join(REPO_ROOT, "dist", "engine-desktop");

export const ENGINE_DESKTOP_TARGETS = [
  { os: "mac", arch: "arm64", bunTarget: "bun-darwin-arm64", platform: "darwin", file: "engine" },
  { os: "win", arch: "x64", bunTarget: "bun-windows-x64", platform: "win32", file: "engine.exe" },
] as const;

export type EngineDesktopTarget = (typeof ENGINE_DESKTOP_TARGETS)[number];

export function engineDesktopPath(outDir: string, target: EngineDesktopTarget): string {
  return join(outDir, target.os, target.arch, target.file);
}

export function engineMetafile(outDir: string, target: EngineDesktopTarget): string {
  return join(outDir, "meta", `${target.os}-${target.arch}.json`);
}

export function nativeDependenciesCommand(target: EngineDesktopTarget): string[] {
  return ["bun", "install", "--frozen-lockfile", `--os=${target.platform}`, `--cpu=${target.arch}`];
}

async function run(command: string[], label: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

export function engineBuildCommand(
  target: EngineDesktopTarget,
  version: string,
  outFile: string,
  metafile: string,
): string[] {
  return compileCommand({
    entries: ENGINE_ENTRIES,
    root: true,
    target: target.bunTarget,
    version,
    outfile: outFile,
    metafile,
  });
}

export function selectTargets(names: string[]): EngineDesktopTarget[] {
  if (names.length === 0) return [...ENGINE_DESKTOP_TARGETS];
  return names.map((name) => {
    const target = ENGINE_DESKTOP_TARGETS.find((t) => `${t.os}-${t.arch}` === name);
    if (!target) {
      const known = ENGINE_DESKTOP_TARGETS.map((t) => `${t.os}-${t.arch}`).join(", ");
      throw new Error(`unknown engine target ${name}; known targets: ${known}`);
    }
    return target;
  });
}

function parseArgs(argv: string[]): { out: string; targets: string[] } {
  let out = DEFAULT_OUT;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out = argv[++i] ?? out;
    else if (arg === "--target") targets.push(argv[++i] ?? "");
    else throw new Error(`unknown argument ${arg}`);
  }
  return { out, targets };
}

async function resolveVersion(): Promise<string> {
  if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION;
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version as string;
}

async function main(): Promise<void> {
  const { out, targets } = parseArgs(Bun.argv.slice(2));
  const version = await resolveVersion();
  for (const target of selectTargets(targets)) {
    const outFile = engineDesktopPath(out, target);
    const metafile = engineMetafile(out, target);
    await mkdir(dirname(outFile), { recursive: true });
    await mkdir(dirname(metafile), { recursive: true });
    await run(
      nativeDependenciesCommand(target),
      `installing the ${target.platform}-${target.arch} packages`,
    );
    await run(
      engineBuildCommand(target, version, outFile, metafile),
      `bun build for ${target.bunTarget}`,
    );
    const { size } = await stat(outFile);
    console.log(`engine ${version} ${target.os}-${target.arch}: ${outFile} (${size} bytes)`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
