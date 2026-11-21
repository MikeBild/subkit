import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  keepBundlePath,
  type LinkedFile,
  linkProblems,
  POSTGRES_TARGETS,
  type PostgresTarget,
  parseOtoolDependencies,
  stripTopFolder,
} from "../src/shared/local/postgres-bundle.ts";
import manifest from "../vendor/postgres.json";

const root = resolve(import.meta.dir, "..");
export const POSTGRES_RESOURCES = join(root, "resources/postgres");
const CACHE = join(POSTGRES_RESOURCES, ".cache");
const MARKER = ".bundle.json";

interface Asset {
  asset: string;
  bytes: number;
  sha256: string;
}

function assetFor(target: PostgresTarget): Asset {
  const asset = (manifest.targets as Record<string, Asset | undefined>)[target];
  if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256))
    throw new Error(`no pinned asset for ${target}`);
  return asset;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(path: string, asset: Asset): Promise<boolean> {
  const file = Bun.file(path);
  return (
    (await file.exists()) && file.size === asset.bytes && (await sha256Of(path)) === asset.sha256
  );
}

async function download(asset: Asset): Promise<string> {
  const target = join(CACHE, asset.asset);
  if (await verified(target, asset)) return target;
  await mkdir(CACHE, { recursive: true });
  const url = `${manifest.source}/releases/download/${manifest.version}/${asset.asset}`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
      const partial = `${target}.partial`;
      await Bun.write(partial, response);
      if (!(await verified(partial, asset))) {
        await rm(partial, { force: true });
        throw new Error(`${asset.asset}: size or SHA-256 does not match the pinned value`);
      }
      await rename(partial, target);
      return target;
    } catch (error) {
      if (attempt >= 3 || String(error).includes("does not match")) throw error;
      await Bun.sleep(2000 * attempt);
    }
  }
}

async function listFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

async function checkLinks(folder: string, kept: string[]): Promise<void> {
  const binaries = kept.filter((path) => path.startsWith("bin/") || path.endsWith(".dylib"));
  const linked: LinkedFile[] = binaries.map((file) => ({
    file,
    dependencies: parseOtoolDependencies(run(["otool", "-L", join(folder, file)])),
  }));
  const problems = linkProblems(linked, new Set(kept));
  if (problems.length > 0) throw new Error(`bundle is not self-contained:\n${problems.join("\n")}`);
}

export async function fetchPostgres(target: PostgresTarget): Promise<string> {
  const asset = assetFor(target);
  const destination = join(POSTGRES_RESOURCES, target);
  const marker = Bun.file(join(destination, MARKER));
  if ((await marker.exists()) && (await marker.json()).sha256 === asset.sha256) return destination;

  const archive = await download(asset);
  await mkdir(POSTGRES_RESOURCES, { recursive: true });
  const unpacked = await mkdtemp(join(POSTGRES_RESOURCES, ".unpack-"));
  const staged = await mkdtemp(join(POSTGRES_RESOURCES, ".stage-"));
  try {
    run(["tar", "-xf", archive, "-C", unpacked]);
    const kept: string[] = [];
    for (const path of await listFiles(unpacked)) {
      const inner = stripTopFolder(path);
      if (!inner || !keepBundlePath(inner, target)) continue;
      const source = await realpath(join(unpacked, path));
      if (!source.startsWith(`${await realpath(unpacked)}${sep}`))
        throw new Error(`${path} points outside the archive`);
      if (!(await stat(source)).isFile()) continue;
      const copy = join(staged, inner);
      await mkdir(dirname(copy), { recursive: true });
      await copyFile(source, copy);
      const executable = inner.startsWith("bin/") || /\.(dylib|dll)$/.test(inner);
      await chmod(copy, executable ? 0o755 : 0o644);
      kept.push(inner);
    }
    if (target.startsWith("darwin") && process.platform === "darwin")
      await checkLinks(staged, kept);
    await Bun.write(
      join(staged, MARKER),
      `${JSON.stringify({ version: manifest.version, target, sha256: asset.sha256, files: kept.length })}\n`,
    );
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    return destination;
  } finally {
    await rm(unpacked, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
}

function requestedTargets(argv: string[]): PostgresTarget[] {
  const named = argv
    .flatMap((arg, index) => (arg === "--target" ? [argv[index + 1] ?? ""] : []))
    .filter(Boolean);
  if (named.includes("all")) return [...POSTGRES_TARGETS];
  if (named.length > 0) {
    for (const name of named)
      if (!(POSTGRES_TARGETS as readonly string[]).includes(name))
        throw new Error(`unknown PostgreSQL target ${name}`);
    return named as PostgresTarget[];
  }
  return POSTGRES_TARGETS.filter((target) => target.startsWith(process.platform));
}

if (import.meta.main) {
  for (const target of requestedTargets(process.argv.slice(2))) {
    const folder = await fetchPostgres(target);
    console.log(`postgres ${manifest.version} ${target} verified in ${relative(root, folder)}`);
  }
}
