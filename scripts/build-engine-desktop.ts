import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileCommand, ENGINE_ENTRIES } from "./lib/commands.ts";
import { type EngineDesktopTarget, parseEngineDesktopArgs } from "./lib/engine-desktop-targets.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_OUT = join(REPO_ROOT, "dist", "engine-desktop");

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

async function resolveVersion(): Promise<string> {
  if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION;
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg.version as string;
}

async function main(): Promise<void> {
  const parsed = parseEngineDesktopArgs(Bun.argv.slice(2));
  if (!parsed.ok) throw new Error(parsed.error);
  const out = parsed.args.out ?? DEFAULT_OUT;
  const version = await resolveVersion();
  for (const target of parsed.args.targets) {
    const outFile = engineDesktopPath(out, target);
    const metafile = engineMetafile(out, target);
    await mkdir(dirname(outFile), { recursive: true });
    await mkdir(dirname(metafile), { recursive: true });
    await run(nativeDependenciesCommand(target), `installing the ${target.name} packages`);
    await run(
      engineBuildCommand(target, version, outFile, metafile),
      `bun build for ${target.bunTarget}`,
    );
    const { size } = await stat(outFile);
    console.log(`engine ${version} ${target.name}: ${outFile} (${size} bytes)`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
