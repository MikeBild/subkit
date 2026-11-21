import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  AGENT_DESKTOP_FILES,
  AGENT_DESKTOP_TARGET,
  parseCodesignDetails,
  signingProblem,
  teamOfIdentity,
} from "../src/shared/local/agent-desktop-bundle.ts";
import manifest from "../vendor/agent-desktop.json";

const root = resolve(import.meta.dir, "..");
const RESOURCES = join(root, "resources/agent-desktop");
const CACHE = join(RESOURCES, ".cache");
const MARKER = ".bundle.json";
const CODESIGN_TIMEOUT_MS = 120_000;

interface Target {
  asset: string;
  bytes: number;
  sha256: string;
  files: Record<string, string>;
}

const target = manifest.targets[AGENT_DESKTOP_TARGET] as Target;

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return (
    (await file.exists()) && file.size === target.bytes && (await sha256Of(path)) === target.sha256
  );
}

async function download(): Promise<string> {
  const archive = join(CACHE, target.asset);
  if (await verified(archive)) return archive;
  await mkdir(CACHE, { recursive: true });
  const url = `${manifest.source}/releases/download/v${manifest.version}/${target.asset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const partial = `${archive}.partial`;
  await Bun.write(partial, response);
  if (!(await verified(partial))) {
    await rm(partial, { force: true });
    throw new Error(`${target.asset}: size or SHA-256 does not match the pinned value`);
  }
  await rename(partial, archive);
  return archive;
}

function run(command: string[], timeout = CODESIGN_TIMEOUT_MS): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString().trim() || "timed out"}`);
  }
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function sign(path: string, identity: string): void {
  const team = teamOfIdentity(identity);
  if (!team) throw new Error(`"${identity}" names no team`);
  run(["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity, path]);
  run(["codesign", "--verify", "--strict", path]);
  const problem = signingProblem(parseCodesignDetails(run(["codesign", "-dv", path])), team);
  if (problem) throw new Error(`${path}: ${problem}`);
}

export async function fetchAgentDesktop(identity: string | null): Promise<string> {
  const destination = join(RESOURCES, AGENT_DESKTOP_TARGET);
  const marker = Bun.file(join(destination, MARKER));
  if ((await marker.exists()) && (await marker.json()).sha256 === target.sha256 && !identity) {
    return destination;
  }
  const archive = await download();
  const unpacked = await mkdtemp(join(RESOURCES, ".unpack-"));
  const staged = await mkdtemp(join(RESOURCES, ".stage-"));
  try {
    run(["tar", "-xzf", archive, "-C", unpacked, ...AGENT_DESKTOP_FILES]);
    for (const name of AGENT_DESKTOP_FILES) {
      const source = join(unpacked, name);
      if ((await sha256Of(source)) !== target.files[name]) {
        throw new Error(`${name}: SHA-256 does not match the pinned value`);
      }
      await copyFile(source, join(staged, name));
      await chmod(join(staged, name), 0o755);
      if (identity) sign(join(staged, name), identity);
    }
    await Bun.write(
      join(staged, MARKER),
      `${JSON.stringify({ version: manifest.version, sha256: target.sha256, signed: identity !== null })}\n`,
    );
    await rm(destination, { recursive: true, force: true });
    await rename(staged, destination);
    return destination;
  } finally {
    await rm(unpacked, { recursive: true, force: true });
    await rm(staged, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.log("agent-desktop is bundled on macOS only; nothing to fetch");
    process.exit(0);
  }
  const index = process.argv.indexOf("--sign");
  const identity = index >= 0 ? (process.argv[index + 1] ?? null) : null;
  const folder = await fetchAgentDesktop(identity);
  console.log(
    `agent-desktop ${manifest.version} ${AGENT_DESKTOP_TARGET} verified${identity ? " and signed" : ""} in ${relative(root, folder)}`,
  );
}
