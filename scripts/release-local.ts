import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateReleaseHistory, renderReleaseHistory } from "./gen-release-notes.ts";
import { dockerAvailableKiB, dockerStorageProblem } from "./lib/cockpit-demo-storage.ts";
import {
  assertReleaseSigningKey,
  LOCAL_RELEASE_FILES,
  signLocalBundle,
  verifyLocalBundle,
} from "./local-release-bundle.ts";
import { assertReleaseGateStatus, releaseGateContext } from "./release-gate-provenance.ts";

const root = resolve(import.meta.dir, "..");
const repository = "MikeBild/subkit";
const registries = ["docker.io/mikebild/subkit", "ghcr.io/mikebild/subkit"];

function run(command: string, args: string[], cwd = root, env = process.env): string {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  }).trim();
}

function visible(command: string, args: string[], cwd = root, env = process.env): void {
  execFileSync(command, args, { cwd, env, stdio: "inherit", timeout: 3_600_000 });
}

export function selectedReleaseCommit(refs: string, tag: string): string {
  const lines = refs
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  const direct = lines.find((line) => line[1] === `refs/tags/${tag}`)?.[0];
  const peeled = lines.find((line) => line[1] === `refs/tags/${tag}^{}`)?.[0];
  if (!direct || !/^[a-f0-9]{40}$/.test(peeled ?? direct))
    throw new Error("Remote release tag is missing or malformed");
  return peeled ?? direct;
}

function candidate(tag: string): string {
  releaseGateContext(tag);
  if (Bun.version !== readFileSync(join(root, ".bun-version"), "utf8").trim())
    throw new Error("Use the pinned Bun version");
  if (run("git", ["status", "--porcelain"]) || run("git", ["branch", "--show-current"]) !== "main")
    throw new Error("A clean main checkout is required");
  const commit = run("git", ["rev-parse", "HEAD"]);
  if (`v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}` !== tag)
    throw new Error("Tag differs from package version");
  if (run("git", ["rev-parse", `${tag}^{commit}`]) !== commit)
    throw new Error("Local tag differs from checkout");
  const remote = run("git", [
    "ls-remote",
    "origin",
    "refs/heads/main",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  if (
    selectedReleaseCommit(remote, tag) !== commit ||
    !remote.split(/\r?\n/).includes(`${commit}\trefs/heads/main`)
  )
    throw new Error("Remote main or tag differs from checkout");
  const info = JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"]));
  if (info.nameWithOwner.toLowerCase() !== repository.toLowerCase())
    throw new Error("Unexpected GitHub repository");
  const gate = JSON.parse(run("gh", ["api", `repos/${repository}/commits/${commit}/status`]));
  assertReleaseGateStatus(gate, tag, commit);
  return commit;
}

function inspectImage(image: string, commit: string, tag: string): string {
  const info = JSON.parse(run("docker", ["image", "inspect", image]))[0];
  if (
    info?.Os !== "linux" ||
    info?.Architecture !== "amd64" ||
    info?.Config?.Labels?.["org.opencontainers.image.revision"] !== commit ||
    info?.Config?.Labels?.["org.opencontainers.image.version"] !== tag.slice(1) ||
    !/^sha256:[a-f0-9]{64}$/.test(info?.Id ?? "")
  )
    throw new Error("Image identity or platform differs from release candidate");
  return info.Id;
}

function assertNoPublishedVersion(tag: string): void {
  const release = spawnSync("gh", ["api", `repos/${repository}/releases/tags/${tag}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (release.status === 0) throw new Error("GitHub release already exists; never overwrite it");
  if (!release.stderr.includes("HTTP 404"))
    throw new Error("Cannot establish that the GitHub release is absent");
  for (const registry of registries) {
    const image = spawnSync(
      "docker",
      ["buildx", "imagetools", "inspect", `${registry}:${tag.slice(1)}`],
      { cwd: root, encoding: "utf8" },
    );
    if (image.status === 0) throw new Error("Registry version already exists; never overwrite it");
    if (
      !/manifest unknown|no such manifest|not found/i.test(image.stderr) ||
      /unauthorized|denied|timeout|connection/i.test(image.stderr)
    )
      throw new Error("Cannot establish that the registry version is absent");
  }
}

async function prepare(tag: string, keyFile: string): Promise<void> {
  const commit = candidate(tag);
  assertNoPublishedVersion(tag);
  const keyPath = realpathSync(keyFile);
  const keyRelative = relative(root, keyPath);
  if (
    (!keyRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(keyRelative)) ||
    (statSync(keyPath).mode & 0o077) !== 0
  )
    throw new Error("Signing key must be owner-only and outside the repository");
  const signingKey = readFileSync(keyPath, "utf8");
  assertReleaseSigningKey(signingKey);
  const directory = join(root, ".artifacts/local-release", tag);
  if (existsSync(directory))
    throw new Error(
      "Preparation directory already exists; preserve and review the previous attempt",
    );
  const builder = readFileSync(join(root, "Dockerfile"), "utf8").match(
    /^FROM (\S+) AS builder$/m,
  )?.[1];
  if (!builder) throw new Error("Pinned builder image not found");
  const disk = run("docker", [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--entrypoint",
    "df",
    builder,
    "-Pk",
    "/",
  ]);
  const problem = dockerStorageProblem(dockerAvailableKiB(disk), true);
  if (problem) throw new Error(problem);
  const source = join(directory, "source");
  const assets = join(directory, "assets");
  mkdirSync(source, { recursive: true });
  mkdirSync(assets);
  const archive = join(directory, "source.tar");
  run("git", ["archive", "--format=tar", "--output", archive, commit]);
  run("tar", ["-xf", archive, "-C", source]);
  rmSync(archive);
  const history = generateReleaseHistory(root, tag);
  writeFileSync(
    join(source, "apps/cockpit/src/app/release-notes.generated.ts"),
    renderReleaseHistory(history),
  );
  const notes = history.releases.find((release) => release.version === tag);
  if (!notes) throw new Error("Release notes are missing");
  writeFileSync(
    join(assets, "release-notes.md"),
    notes.notes.length
      ? `${notes.notes.map((note) => `- ${note}`).join("\n")}\n`
      : "No short notes were recorded for this version.\n",
  );
  const image = `subkit:release-local-${commit.slice(0, 12)}`;
  visible(
    "docker",
    [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--load",
      "--build-arg",
      `ENGINE_VERSION=${tag.slice(1)}`,
      "--label",
      `org.opencontainers.image.source=https://github.com/${repository}`,
      "--label",
      `org.opencontainers.image.revision=${commit}`,
      "--label",
      `org.opencontainers.image.version=${tag.slice(1)}`,
      "-t",
      image,
      ".",
    ],
    source,
  );
  const imageId = inspectImage(image, commit, tag);
  const project = `subkit-release-${commit.slice(0, 12)}`;
  for (const args of [
    ["ps", "-aq"],
    ["volume", "ls", "-q"],
    ["network", "ls", "-q"],
  ]) {
    if (run("docker", [...args, "--filter", `label=com.docker.compose.project=${project}`]))
      throw new Error("Release smoke project already has resources; refusing to reuse them");
  }
  const env = {
    ...process.env,
    SUBKIT_IMAGE: imageId,
    MASTER_KEY: "a".repeat(64),
    SUBKIT_DB_PASSWORD: "subkit-release-only",
    SUBKIT_BOOTSTRAP_KEY: "b".repeat(64),
    BIND_ADDRESS: "127.0.0.1",
    SUBKIT_HOST_PORT: "43180",
    SUBKIT_DB_PORT: "43181",
  };
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    project,
    "-f",
    join(source, "docker-compose.yml"),
  ];
  try {
    visible(
      "docker",
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "360"],
      source,
      env,
    );
    const health = await fetch("http://127.0.0.1:43180/health", {
      signal: AbortSignal.timeout(10000),
    });
    if (!health.ok || ((await health.json()) as { version?: string }).version !== tag.slice(1))
      throw new Error("Release health/version smoke failed");
    const ready = await fetch("http://127.0.0.1:43180/ready", {
      signal: AbortSignal.timeout(10000),
    });
    if (!ready.ok) throw new Error("Release readiness smoke failed");
    visible("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--entrypoint",
      "/usr/local/bin/engine.bin",
      imageId,
      "--smoke",
    ]);
  } finally {
    visible("docker", [...compose, "down", "--volumes", "--remove-orphans"], source, env);
  }
  const container = run("docker", ["create", "--platform", "linux/amd64", imageId]);
  try {
    run("docker", [
      "cp",
      `${container}:/usr/local/bin/engine.bin`,
      join(assets, "engine_linux_x64"),
    ]);
    run("docker", ["cp", `${container}:/usr/local/share/subkit/binaries/.`, assets]);
  } finally {
    run("docker", ["rm", container]);
  }
  cpSync(join(source, "docker-compose.yml"), join(assets, "docker-compose.yml"));
  cpSync(join(source, "assets/clipper/clipper.zip"), join(assets, "subkit-clipper.zip"));
  if (candidate(tag) !== commit) throw new Error("Candidate changed during preparation");
  writeFileSync(
    join(assets, "release-provenance.json"),
    `${JSON.stringify({ tag, commit, imageId, platform: "linux/amd64", gateContext: releaseGateContext(tag), smoke: "passed" }, null, 2)}\n`,
  );
  signLocalBundle(assets, signingKey);
  verifyLocalBundle(assets, tag, commit);
  console.log(`Prepared ${tag} at ${assets}; nothing published.`);
}

function publish(tag: string): void {
  const commit = candidate(tag);
  if (run("gh", ["api", `repos/${repository}`, "--jq", ".private"]) !== "false")
    throw new Error("Public release requires an already public repository");
  assertNoPublishedVersion(tag);
  const assets = join(root, ".artifacts/local-release", tag, "assets");
  const provenance = verifyLocalBundle(assets, tag, commit);
  if (inspectImage(provenance.imageId, commit, tag) !== provenance.imageId)
    throw new Error("Prepared image changed");
  for (const registry of registries) {
    const versioned = `${registry}:${tag.slice(1)}`;
    run("docker", ["tag", provenance.imageId, versioned]);
    visible("docker", ["push", versioned]);
    visible("docker", ["pull", "--platform", "linux/amd64", versioned]);
    if (inspectImage(versioned, commit, tag) !== provenance.imageId)
      throw new Error("Published image differs from prepared image");
  }
  visible("gh", [
    "release",
    "create",
    tag,
    ...[...LOCAL_RELEASE_FILES, "SHA256SUMS", "SHA256SUMS.sig"].map((file) => join(assets, file)),
    "--repo",
    repository,
    "--verify-tag",
    "--title",
    tag,
    "--notes-file",
    join(assets, "release-notes.md"),
  ]);
  const downloaded = mkdtempSync(join(tmpdir(), "subkit-release-download-"));
  try {
    run("gh", ["release", "download", tag, "--repo", repository, "--dir", downloaded]);
    verifyLocalBundle(downloaded, tag, commit);
  } finally {
    rmSync(downloaded, { recursive: true, force: true });
  }
  for (const registry of registries) {
    run("docker", ["tag", provenance.imageId, `${registry}:latest`]);
    visible("docker", ["push", `${registry}:latest`]);
  }
  console.log(
    `Published and downloaded ${tag}; anonymous installation acceptance remains separate.`,
  );
}

if (import.meta.main) {
  const [action, tag, flag, value, ...extra] = process.argv.slice(2);
  if (!tag || extra.length)
    throw new Error(
      "Expected check TAG, prepare TAG --signing-key-file PATH, or publish TAG --confirm-publish TAG",
    );
  if (action === "check" && !flag)
    console.log(`Release candidate ${candidate(tag)} has its mandatory gate.`);
  else if (action === "prepare" && flag === "--signing-key-file" && value)
    await prepare(tag, value);
  else if (action === "publish" && flag === "--confirm-publish" && value === tag) publish(tag);
  else throw new Error("Invalid arguments; publication requires explicit --confirm-publish TAG");
}
