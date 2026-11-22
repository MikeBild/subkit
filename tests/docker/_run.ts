import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { releaseAssetFor } from "../../packages/cli-core/src/release/assets.ts";
import { gitVisibleSourceDigest } from "../../scripts/lib/source-digest.ts";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const DOCKER_STOP_TIMEOUT_SECONDS = 160;

export interface DockerTestRun {
  runId: string;
  project: string;
  image: string;
  apiPort: string;
  dbPort: string;
  publishedDbPort?: string;
  baseUrl: string;
  owned: boolean;
  receiptPath?: string;
  hostCliPath?: string;
}

export function withPublishedPorts(
  run: DockerTestRun,
  apiPort: string,
  dbPort: string,
): DockerTestRun {
  return { ...run, baseUrl: `http://127.0.0.1:${apiPort}`, publishedDbPort: dbPort };
}

function command(command: string, args: string[], env = process.env) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function output(commandName: string, args: string[]): string {
  const result = command(commandName, args);
  if (result.status !== 0)
    throw new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout ?? "";
}

function sourceDigest(): { revision: string; dirty: boolean; digest: string } {
  return gitVisibleSourceDigest(REPO_ROOT);
}

export function createDockerTestRun(
  label = "run",
  inherited: NodeJS.ProcessEnv = process.env,
): DockerTestRun {
  const suffix = `${process.pid.toString(36)}-${randomUUID().slice(0, 8)}`;
  const runId = inherited.SUBKIT_DOCKER_RUN_ID ?? randomUUID();
  const project = inherited.SUBKIT_DOCKER_PROJECT ?? `subkit-test-${label}-${suffix}`;
  const apiPort = inherited.SUBKIT_TEST_PORT ?? "0";
  const dbPort = inherited.SUBKIT_DB_PORT ?? "0";
  const image = inherited.SUBKIT_TEST_IMAGE ?? `subkit:docker-test-${suffix}`;
  return {
    runId,
    project,
    image,
    apiPort,
    dbPort,
    baseUrl: inherited.SUBKIT_DOCKER_BASE_URL ?? `http://127.0.0.1:${apiPort}`,
    owned: inherited.SUBKIT_DOCKER_OWNED === "1" || !inherited.SUBKIT_DOCKER_PROJECT,
  };
}

export function createIsolatedDockerTestRun(
  label = "run",
  _foreignEnv?: NodeJS.ProcessEnv,
): DockerTestRun {
  return createDockerTestRun(label, {});
}

export function runEnv(run: DockerTestRun): Record<string, string> {
  return {
    SUBKIT_DOCKER_RUN_ID: run.runId,
    SUBKIT_DOCKER_PROJECT: run.project,
    COMPOSE_PROJECT_NAME: run.project,
    SUBKIT_TEST_IMAGE: run.image,
    SUBKIT_TEST_PORT: run.apiPort,
    SUBKIT_DB_PORT: run.dbPort,
    SUBKIT_DOCKER_BASE_URL: run.baseUrl,
    SUBKIT_DOCKER_RECEIPT: run.receiptPath ?? "",
    SUBKIT_DOCKER_OWNED: run.owned ? "1" : "0",
    SUBKIT_DOCKER_HOST_CLI: run.hostCliPath ?? "",
  };
}

export function dockerTestChildEnv(
  run: DockerTestRun,
  mode: "cold" | "warm",
  seedState: "natural" | "unchanged" | "changed",
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.SUBKIT_DOCKER_KEEP_ALIVE;
  if (run.owned) delete env.SUBKIT_DOCKER_API_KEY;
  return {
    ...env,
    ...runEnv(run),
    SUBKIT_DOCKER_MANAGED: "1",
    SUBKIT_DOCKER_KEEP_ALIVE: mode === "warm" ? "1" : "0",
    SUBKIT_DOCKER_SEED_STATE: seedState,
    NODE_ENV: "test",
  };
}

export interface DockerBuildReceipt {
  created_at: string;
  project: string;
  image: string;
  image_id: string;
  source: { revision: string; dirty: boolean; digest: string };
  context: DockerContextEvidence;
  platform: string;
  build_args: Record<string, string>;
  binaries: Record<string, string>;
  host_cli: { path: string; sha256: string; platform: string };
}

export interface DockerContextEvidence {
  digest: string;
  manifest_sha256: string;
  entries: number;
}

export function parseDockerContextEvidence(
  digestText: string,
  manifest: string,
): DockerContextEvidence {
  const digest = digestText.trim();
  if (!/^[a-f0-9]{64}$/i.test(digest))
    throw new Error("image build-context digest must be a SHA-256 hex value");
  const entries = manifest.split("\n").filter(Boolean).length;
  if (entries === 0) throw new Error("image build-context manifest is empty");
  return {
    digest,
    manifest_sha256: createHash("sha256").update(manifest).digest("hex"),
    entries,
  };
}

function extractBuildContext(image: string): DockerContextEvidence {
  const dir = mkdtempSync(path.join(tmpdir(), "subkit-docker-context-"));
  const container = output("docker", ["create", image]).trim();
  try {
    for (const file of ["BUILD_CONTEXT_DIGEST", "BUILD_CONTEXT_MANIFEST.txt"]) {
      if (
        command("docker", [
          "cp",
          `${container}:/usr/local/share/subkit/${file}`,
          path.join(dir, file),
        ]).status !== 0
      )
        throw new Error(`could not extract ${file} from ${image}`);
    }
    return parseDockerContextEvidence(
      readFileSync(path.join(dir, "BUILD_CONTEXT_DIGEST"), "utf8"),
      readFileSync(path.join(dir, "BUILD_CONTEXT_MANIFEST.txt"), "utf8"),
    );
  } finally {
    command("docker", ["rm", "-f", container]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function extractHostCli(image: string): {
  path: string;
  sha256: string;
  platform: string;
} {
  const platform = `${process.platform}_${process.arch}`;
  const filename = releaseAssetFor("subkit", process.platform, process.arch);
  if (!filename) throw new Error(`no subkit build for ${platform}`);
  const dir = mkdtempSync(path.join(tmpdir(), "subkit-docker-host-cli-"));
  const container = output("docker", ["create", image]).trim();
  try {
    if (
      command("docker", [
        "cp",
        `${container}:/usr/local/share/subkit/binaries/${filename}`,
        path.join(dir, filename),
      ]).status !== 0 ||
      command("docker", [
        "cp",
        `${container}:/usr/local/share/subkit/binaries/SHA256SUMS`,
        path.join(dir, "SHA256SUMS"),
      ]).status !== 0
    )
      throw new Error(`could not extract ${filename} from ${image}`);
  } finally {
    command("docker", ["rm", "-f", container]);
  }
  const binary = path.join(dir, filename);
  chmodSync(binary, 0o755);
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const expected = readFileSync(path.join(dir, "SHA256SUMS"), "utf8")
    .split("\n")
    .find((line) => line.endsWith(` ${filename}`))
    ?.split(/\s+/)[0];
  if (expected !== sha256) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`host CLI SHA-256 mismatch for ${filename}`);
  }
  return { path: binary, sha256, platform };
}

export function buildFreshImage(run: DockerTestRun): DockerTestRun {
  const cliBinariesSource = "generated-cli";
  const source = sourceDigest();
  const env = {
    ...process.env,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(userInfo().homedir, ".docker"),
    ...runEnv(run),
  };
  const build = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      run.project,
      "-f",
      "docker/docker-compose.test.yml",
      "build",
      "--build-arg",
      `CLI_BINARIES_SOURCE=${cliBinariesSource}`,
      "engine",
    ],
    { cwd: REPO_ROOT, env, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error(`fresh Docker build failed (${build.status})`);
  const sourceAfter = sourceDigest();
  if (sourceAfter.digest !== source.digest)
    throw new Error(
      "Git-visible source changed during Docker build; refusing an unverifiable receipt",
    );
  const imageId = output("docker", ["image", "inspect", "--format", "{{.Id}}", run.image]).trim();
  const context = extractBuildContext(imageId);
  const hashes = output("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "/bin/sh",
    imageId,
    "-c",
    "sha256sum /usr/local/bin/engine.bin /usr/local/bin/subkit.bin",
  ]);
  const binaries = Object.fromEntries(
    hashes
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
        return match ? [[match[2], match[1]]] : [];
      }),
  );
  if (
    Object.keys(binaries).length !== 2 ||
    !binaries["/usr/local/bin/engine.bin"] ||
    !binaries["/usr/local/bin/subkit.bin"]
  )
    throw new Error(
      "image receipt did not contain exactly engine.bin and subkit.bin SHA-256 hashes",
    );
  const hostCli = extractHostCli(imageId);
  const platform = output("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Os}}/{{.Architecture}}",
    imageId,
  ]).trim();
  const receipt: DockerBuildReceipt = {
    created_at: new Date().toISOString(),
    project: run.project,
    image: run.image,
    image_id: imageId,
    source,
    context,
    platform,
    build_args: {
      CLI_BINARIES_SOURCE: cliBinariesSource,
    },
    binaries,
    host_cli: hostCli,
  };
  const receiptPath = path.join(tmpdir(), `subkit-docker-receipt-${run.project}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `[docker-receipt] ${receiptPath} image=${imageId} context=${receipt.context.digest}\n`,
  );

  return { ...run, image: imageId, receiptPath, hostCliPath: hostCli.path };
}

export interface DockerCleanupResult {
  profileCaptureFailed: boolean;
  cleanupFailed: boolean;
}

export function hasValidCpuProfile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { recursive: true }).some((file) => {
    if (typeof file !== "string" || !file.endsWith(".cpuprofile")) return false;
    try {
      const value = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
      return (
        Array.isArray(value.nodes) &&
        value.nodes.length > 0 &&
        Array.isArray(value.samples) &&
        value.samples.length > 0 &&
        Array.isArray(value.timeDeltas) &&
        value.timeDeltas.length === value.samples.length &&
        Number.isFinite(value.startTime) &&
        Number.isFinite(value.endTime) &&
        value.endTime > value.startTime
      );
    } catch {
      return false;
    }
  });
}

export function cleanupDockerTestRun(run: DockerTestRun): DockerCleanupResult {
  if (!run.owned) return { profileCaptureFailed: false, cleanupFailed: false };
  const artifactDir = path.join(tmpdir(), `subkit-docker-artifacts-${run.project}`);
  mkdirSync(artifactDir, { recursive: true });
  const env = {
    ...process.env,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(userInfo().homedir, ".docker"),
    ...runEnv(run),
  };
  const composeArgs = ["compose", "-p", run.project, "-f", "docker/docker-compose.test.yml"];

  spawnSync("docker", [...composeArgs, "stop", "--timeout", String(DOCKER_STOP_TIMEOUT_SECONDS)], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  const logs = spawnSync("docker", [...composeArgs, "logs", "--no-color"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  writeFileSync(
    path.join(artifactDir, "compose.log"),
    `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
  );
  const ids = spawnSync("docker", [...composeArgs, "ps", "--all", "-q"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  const containerIds = (ids.stdout ?? "").split("\n").filter(Boolean);
  const cpuProfilingEnabled = /(?:^|\s)--cpu-prof(?:\s|=|$)/.test(
    process.env.SUBKIT_BUN_OPTIONS ?? "",
  );
  const engineId = spawnSync("docker", [...composeArgs, "ps", "--all", "-q", "engine"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  }).stdout?.trim();
  let profileCopied = false;
  for (const id of containerIds) {
    const inspect = spawnSync("docker", ["inspect", id], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    writeFileSync(path.join(artifactDir, `${id}.inspect.json`), inspect.stdout ?? "");

    if (id !== engineId) continue;
    const copied = spawnSync(
      "docker",
      ["cp", `${id}:/tmp/subkit-profiles/.`, path.join(artifactDir, "profiles")],
      { cwd: REPO_ROOT, env, encoding: "utf8" },
    );
    profileCopied ||= copied.status === 0 && hasValidCpuProfile(path.join(artifactDir, "profiles"));
  }
  const profileCaptureFailed = cpuProfilingEnabled && !profileCopied;
  if (profileCaptureFailed) {
    const message = "CPU profiling was enabled but no valid nonempty CPU profile was captured";
    writeFileSync(path.join(artifactDir, "profile-capture-error.txt"), `${message}\n`);

    process.stderr.write(`[docker-artifacts] ${message}\n`);
  }
  process.stdout.write(`[docker-artifacts] ${artifactDir}\n`);
  const result = command(
    "docker",
    [
      "compose",
      "-p",
      run.project,
      "-f",
      "docker/docker-compose.test.yml",
      "down",
      "--volumes",
      "--remove-orphans",
    ],
    env,
  );
  if (result.status !== 0)
    process.stderr.write(`[docker-isolated] cleanup of ${run.project} failed:\n${result.stderr}\n`);
  return { profileCaptureFailed, cleanupFailed: result.status !== 0 };
}
