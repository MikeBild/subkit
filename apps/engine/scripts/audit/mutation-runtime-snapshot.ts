import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, relative, sep } from "node:path";

const VERSION = 1 as const;
const SHA256 = /^[a-f0-9]{64}$/;
const SEAL = "runtime-snapshot.seal.json";

interface RuntimeSnapshotSeal {
  version: 1;
  snapshot_sha256: string;
  wave_id: string;
  run_id: string;
  source_freeze_sha256: string;
  manifest_sha256: string;
  artifact_digest_sha256: string;
  artifacts: readonly {
    path: string;
    bytes: number;
    mode: number;
    dev: number;
    ino: number;
    mtime_ms: number;
  }[];
}

function isCanonicalRepoPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("./") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export const MUTATION_RUNTIME_ARTIFACTS = [
  "apps/engine/assets/embeddings/minilm/config.bin",
  "apps/engine/assets/embeddings/minilm/model_quantized.onnx",
  "apps/engine/assets/embeddings/minilm/special_tokens_map.bin",
  "apps/engine/assets/embeddings/minilm/tokenizer.bin",
  "apps/engine/assets/embeddings/minilm/tokenizer_config.bin",
  "apps/engine/assets/embeddings/onnxruntime/ort-wasm-simd-threaded.asyncify.mjs",
  "apps/engine/assets/embeddings/onnxruntime/ort-wasm-simd-threaded.asyncify.wasm",
  "assets/clipper/clipper.zip",
  "assets/clipper/manifest.json",
  "dist/sk",
] as const;

export interface MutationRuntimeSnapshot {
  version: typeof VERSION;
  wave_id: string;
  run_id: string;
  source_freeze_sha256: string;
  manifest_sha256: string;
  artifact_digest_sha256: string;
  artifacts: readonly { path: string; sha256: string; bytes: number; executable: boolean }[];
}

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function noSymlinkComponents(path: string, label: string): void {
  const absolute = path.startsWith(parse(path).root) ? path : join(process.cwd(), path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[/\\]/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} traverses a symlink`);
  }
}

function regularFile(path: string, label: string): string {
  noSymlinkComponents(path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.nlink !== 1) throw new Error(`${label} must not be hardlinked`);
  return realpathSync(path);
}

function contained(root: string, path: string, label: string): string {
  const realRoot = realpathSync(root);
  const realPath = realpathSync(path);
  const fromRoot = relative(realRoot, realPath);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    throw new Error(`${label} escapes its root`);
  return realPath;
}

function snapshotName(artifactDigest: string, waveId: string, runId: string): string {
  if (!SHA256.test(artifactDigest)) throw new Error("runtime artifact digest must be sha256");
  for (const value of [waveId, runId])
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(value))
      throw new Error("runtime snapshot identity is invalid");
  return `sha256-${artifactDigest}-${waveId}-${runId}`;
}

function artifactRows(repo: string): MutationRuntimeSnapshot["artifacts"] {
  return MUTATION_RUNTIME_ARTIFACTS.map((path) => {
    const source = contained(
      repo,
      regularFile(join(repo, path), `runtime artifact ${path}`),
      `runtime artifact ${path}`,
    );
    const stat = lstatSync(source);
    const executable = (stat.mode & 0o111) !== 0;
    if (path === "dist/sk" && !executable)
      throw new Error("runtime artifact dist/sk must be executable");
    return { path, sha256: sha(readFileSync(source)), bytes: stat.size, executable };
  });
}

function parseSnapshot(path: string): MutationRuntimeSnapshot {
  const raw = JSON.parse(
    readFileSync(regularFile(path, "runtime snapshot manifest"), "utf8"),
  ) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("runtime snapshot manifest is invalid");
  const snapshot = raw as MutationRuntimeSnapshot;
  if (
    snapshot.version !== VERSION ||
    !/^[a-z0-9][a-z0-9-]{0,119}$/.test(snapshot.wave_id) ||
    !/^[a-z0-9][a-z0-9-]{0,119}$/.test(snapshot.run_id) ||
    !SHA256.test(snapshot.source_freeze_sha256) ||
    !SHA256.test(snapshot.manifest_sha256) ||
    !SHA256.test(snapshot.artifact_digest_sha256) ||
    !Array.isArray(snapshot.artifacts) ||
    snapshot.artifacts.length !== MUTATION_RUNTIME_ARTIFACTS.length ||
    snapshot.artifacts.some(
      (artifact) =>
        !artifact ||
        !isCanonicalRepoPath(artifact.path) ||
        !SHA256.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) ||
        artifact.bytes < 1 ||
        typeof artifact.executable !== "boolean",
    ) ||
    JSON.stringify(snapshot.artifacts.map((artifact) => artifact.path)) !==
      JSON.stringify(MUTATION_RUNTIME_ARTIFACTS)
  )
    throw new Error("runtime snapshot manifest has an invalid inventory");
  return snapshot;
}

function assertSnapshotInventory(directory: string): void {
  const expectedEntries = new Set(["runtime-snapshot.json", SEAL, ...MUTATION_RUNTIME_ARTIFACTS]);
  const expectedDirectories = new Set(
    MUTATION_RUNTIME_ARTIFACTS.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    }),
  );
  const visit = (current: string, relativeDirectory = ""): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(current, entry.name);
      noSymlinkComponents(absolutePath, `runtime snapshot entry ${relativePath}`);
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath))
          throw new Error(`runtime snapshot has an unexpected directory ${relativePath}`);
        visit(absolutePath, relativePath);
        continue;
      }
      if (!expectedEntries.delete(relativePath))
        throw new Error(`runtime snapshot has an unexpected entry ${relativePath}`);
    }
  };
  visit(directory);
  expectedEntries.delete(SEAL);
  if (expectedEntries.size > 0) throw new Error("runtime snapshot inventory is incomplete");
}

function verifySnapshot(input: {
  directory: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): MutationRuntimeSnapshot {
  noSymlinkComponents(input.directory, "runtime snapshot directory");
  if (!lstatSync(input.directory).isDirectory())
    throw new Error("runtime snapshot directory is invalid");
  const snapshot = parseSnapshot(join(input.directory, "runtime-snapshot.json"));
  assertSnapshotInventory(input.directory);
  for (const key of Object.keys(input.expected) as (keyof typeof input.expected)[])
    if (snapshot[key] !== input.expected[key]) throw new Error(`runtime snapshot ${key} differs`);
  const digest = createHash("sha256");
  for (const artifact of snapshot.artifacts) {
    const path = contained(
      input.directory,
      regularFile(
        join(input.directory, artifact.path),
        `runtime snapshot artifact ${artifact.path}`,
      ),
      `runtime snapshot artifact ${artifact.path}`,
    );
    const stat = lstatSync(path);
    if (stat.nlink !== 1)
      throw new Error(`runtime snapshot artifact ${artifact.path} must not be hardlinked`);
    if (stat.size !== artifact.bytes)
      throw new Error(`runtime snapshot artifact ${artifact.path} size differs`);
    const actual = sha(readFileSync(path));
    if (actual !== artifact.sha256)
      throw new Error(`runtime snapshot artifact ${artifact.path} bytes differ`);
    digest.update(artifact.path).update("\0").update(actual).update("\0");
  }
  if (digest.digest("hex") !== snapshot.artifact_digest_sha256)
    throw new Error("runtime snapshot artifact digest differs");
  return snapshot;
}

function fastSnapshot(input: {
  path: string;
  sha256: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): MutationRuntimeSnapshot {
  if (!SHA256.test(input.sha256)) throw new Error("runtime snapshot sha256 is invalid");
  noSymlinkComponents(input.path, "runtime snapshot directory");
  assertSnapshotInventory(input.path);
  const snapshot = parseSnapshot(join(input.path, "runtime-snapshot.json"));
  if (sha(readFileSync(join(input.path, "runtime-snapshot.json"))) !== input.sha256)
    throw new Error("runtime snapshot manifest sha256 differs");
  for (const key of Object.keys(input.expected) as (keyof typeof input.expected)[])
    if (snapshot[key] !== input.expected[key]) throw new Error(`runtime snapshot ${key} differs`);
  for (const artifact of snapshot.artifacts) {
    const path = contained(
      input.path,
      regularFile(join(input.path, artifact.path), `runtime snapshot artifact ${artifact.path}`),
      `runtime snapshot artifact ${artifact.path}`,
    );
    if (lstatSync(path).size !== artifact.bytes)
      throw new Error(`runtime snapshot artifact ${artifact.path} size differs`);
  }
  return snapshot;
}

export function assertMutationRuntimeSnapshotFast(input: {
  path: string;
  sha256: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): MutationRuntimeSnapshot {
  return fastSnapshot(input);
}

export function rehydrateMutationRuntimeSnapshot(input: {
  path: string;
  sha256: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): MutationRuntimeSnapshot {
  const snapshot = validateMutationRuntimeSnapshot(input);
  for (const artifact of snapshot.artifacts) {
    if (artifact.executable !== (artifact.path === "dist/sk"))
      throw new Error("runtime snapshot executable inventory is invalid");
    chmodSync(join(input.path, artifact.path), artifact.executable ? 0o555 : 0o444);
  }
  return snapshot;
}

export function sealMutationRuntimeSnapshot(input: {
  path: string;
  sha256: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): string {
  const snapshot = rehydrateMutationRuntimeSnapshot(input);
  const artifacts = snapshot.artifacts.map((artifact) => {
    const stat = lstatSync(join(input.path, artifact.path));
    return {
      path: artifact.path,
      bytes: stat.size,
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino,
      mtime_ms: stat.mtimeMs,
    };
  });
  const seal: RuntimeSnapshotSeal = {
    version: 1,
    snapshot_sha256: input.sha256,
    wave_id: snapshot.wave_id,
    run_id: snapshot.run_id,
    source_freeze_sha256: snapshot.source_freeze_sha256,
    manifest_sha256: snapshot.manifest_sha256,
    artifact_digest_sha256: snapshot.artifact_digest_sha256,
    artifacts,
  };
  const path = join(input.path, SEAL);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    assertSnapshotSeal({
      path: input.path,
      snapshot,
      snapshotSha256: input.sha256,
      sealSha256: sha(readFileSync(path)),
    });
    if (readFileSync(path, "utf8") !== json(seal))
      throw new Error("runtime snapshot seal differs from current host state");
    return sha(readFileSync(path));
  }
  writeFileSync(path, json(seal), { encoding: "utf8", mode: 0o444, flag: "wx" });
  return sha(readFileSync(path));
}

function assertSnapshotSeal(input: {
  path: string;
  snapshot: MutationRuntimeSnapshot;
  snapshotSha256: string;
  sealSha256: string;
}): void {
  const sealPath = join(input.path, SEAL);
  const seal = JSON.parse(
    readFileSync(regularFile(sealPath, "runtime snapshot seal"), "utf8"),
  ) as RuntimeSnapshotSeal;
  if (
    seal.version !== 1 ||
    sha(readFileSync(sealPath)) !== input.sealSha256 ||
    seal.snapshot_sha256 !== input.snapshotSha256 ||
    seal.wave_id !== input.snapshot.wave_id ||
    seal.run_id !== input.snapshot.run_id ||
    seal.source_freeze_sha256 !== input.snapshot.source_freeze_sha256 ||
    seal.manifest_sha256 !== input.snapshot.manifest_sha256 ||
    seal.artifact_digest_sha256 !== input.snapshot.artifact_digest_sha256 ||
    !Array.isArray(seal.artifacts) ||
    seal.artifacts.length !== input.snapshot.artifacts.length ||
    seal.artifacts.some(
      (artifact, index) => artifact?.path !== input.snapshot.artifacts[index]?.path,
    )
  )
    throw new Error("runtime snapshot seal differs");
  for (const expected of seal.artifacts) {
    const stat = lstatSync(
      regularFile(join(input.path, expected.path), `runtime snapshot artifact ${expected.path}`),
    );
    if (
      stat.size !== expected.bytes ||
      (stat.mode & 0o777) !== expected.mode ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.mtimeMs !== expected.mtime_ms
    )
      throw new Error(`runtime snapshot seal artifact ${expected.path} differs`);
  }
}

export function validateMutationRuntimeSnapshot(input: {
  path: string;
  sha256: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): MutationRuntimeSnapshot {
  if (!SHA256.test(input.sha256)) throw new Error("runtime snapshot sha256 is invalid");
  const snapshot = verifySnapshot({ directory: input.path, expected: input.expected });
  if (sha(readFileSync(join(input.path, "runtime-snapshot.json"))) !== input.sha256)
    throw new Error("runtime snapshot manifest sha256 differs");
  return snapshot;
}

export function mutationRuntimeArtifactPaths(): string[] {
  return [...MUTATION_RUNTIME_ARTIFACTS];
}

export function mutationRuntimeArtifactDigest(repo: string): string {
  const digest = createHash("sha256");
  for (const artifact of artifactRows(repo))
    digest.update(artifact.path).update("\0").update(artifact.sha256).update("\0");
  return digest.digest("hex");
}

export function createMutationRuntimeSnapshot(input: {
  repo: string;
  parentRunRoot: string;
  waveId: string;
  runId: string;
  sourceFreezeSha256: string;
  manifestSha256: string;
  artifactDigestSha256: string;
}): { path: string; sha256: string; snapshot: MutationRuntimeSnapshot } {
  const repo = realpathSync(input.repo);
  noSymlinkComponents(input.parentRunRoot, "runtime snapshot parent run root");
  const parentRunRoot = realpathSync(input.parentRunRoot);
  if (!SHA256.test(input.sourceFreezeSha256) || !SHA256.test(input.manifestSha256))
    throw new Error("runtime snapshot requires frozen source and manifest digests");
  if (!SHA256.test(input.artifactDigestSha256))
    throw new Error("runtime snapshot requires a frozen runtime artifact digest");
  const artifactDigest = input.artifactDigestSha256;
  const expected = {
    wave_id: input.waveId,
    run_id: input.runId,
    source_freeze_sha256: input.sourceFreezeSha256,
    manifest_sha256: input.manifestSha256,
    artifact_digest_sha256: artifactDigest,
  };
  const root = join(parentRunRoot, "runtime-snapshots");
  mkdirSync(root, { recursive: true });
  noSymlinkComponents(root, "runtime snapshot root");
  const final = join(root, snapshotName(artifactDigest, input.waveId, input.runId));
  const existingFinal = lstatSync(final, { throwIfNoEntry: false });
  if (existingFinal) {
    if (!existingFinal.isDirectory() || existingFinal.isSymbolicLink())
      throw new Error("runtime snapshot final path is occupied");
    return {
      path: final,
      sha256: sha(readFileSync(join(final, "runtime-snapshot.json"))),
      snapshot: verifySnapshot({ directory: final, expected }),
    };
  }
  const staging = mkdtempSync(join(root, ".staging-"));
  let created = true;
  try {
    const artifacts = artifactRows(repo);
    const actualArtifactDigest = sha(
      artifacts.flatMap((artifact) => [artifact.path, "\0", artifact.sha256, "\0"]).join(""),
    );
    if (actualArtifactDigest !== artifactDigest)
      throw new Error("runtime snapshot artifact bytes differ from frozen wave");
    for (const artifact of artifacts) {
      const destination = join(staging, artifact.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(repo, artifact.path), destination);
      chmodSync(destination, artifact.executable ? 0o555 : 0o444);
    }
    const snapshot: MutationRuntimeSnapshot = { version: VERSION, ...expected, artifacts };
    writeFileSync(join(staging, "runtime-snapshot.json"), json(snapshot), {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx",
    });
    rehydrateMutationRuntimeSnapshot({
      path: staging,
      sha256: sha(readFileSync(join(staging, "runtime-snapshot.json"))),
      expected,
    });
    renameSync(staging, final);
    created = false;
    const verified = rehydrateMutationRuntimeSnapshot({
      path: final,
      sha256: sha(readFileSync(join(final, "runtime-snapshot.json"))),
      expected,
    });
    return {
      path: final,
      sha256: sha(readFileSync(join(final, "runtime-snapshot.json"))),
      snapshot: verified,
    };
  } catch (error) {
    if (created) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function provisionMutationRuntimeSnapshot(input: {
  sandboxRepo: string;
  snapshotPath: string;
  snapshotSha256: string;
  sealSha256?: string;
  expected: Pick<
    MutationRuntimeSnapshot,
    "wave_id" | "run_id" | "source_freeze_sha256" | "manifest_sha256" | "artifact_digest_sha256"
  >;
}): void {
  if (!SHA256.test(input.snapshotSha256)) throw new Error("runtime snapshot sha256 is invalid");
  const snapshot = fastSnapshot({
    path: input.snapshotPath,
    sha256: input.snapshotSha256,
    expected: input.expected,
  });
  if (input.sealSha256 !== undefined)
    assertSnapshotSeal({
      path: input.snapshotPath,
      snapshot,
      snapshotSha256: input.snapshotSha256,
      sealSha256: input.sealSha256,
    });
  const sandbox = realpathSync(input.sandboxRepo);
  for (const artifact of snapshot.artifacts) {
    const destination = join(sandbox, artifact.path);
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    noSymlinkComponents(parent, `runtime sandbox parent ${artifact.path}`);
    const source = regularFile(
      join(input.snapshotPath, artifact.path),
      `runtime snapshot artifact ${artifact.path}`,
    );
    try {
      const existing = lstatSync(destination);
      if (!existing.isSymbolicLink() || realpathSync(destination) !== source)
        throw new Error(`runtime sandbox artifact ${artifact.path} already exists`);
      if (readlinkSync(destination).length === 0)
        throw new Error(`runtime sandbox artifact ${artifact.path} has an invalid link`);
      continue;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    symlinkSync(source, destination, "file");
  }
}
