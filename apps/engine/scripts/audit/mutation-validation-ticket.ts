import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  mutationClosureFiles,
  mutationTestInputs,
  patchedDependencyInputs,
} from "./mutation-inputs.ts";
import type { MutationRuntimeSnapshot } from "./mutation-runtime-snapshot.ts";
import { assertMutationRuntimeSnapshotFast } from "./mutation-runtime-snapshot.ts";
import { digestCanonical, digestWaveFiles, type MutationWaveManifest } from "./mutation-wave.ts";
import type { PureTargetEntry } from "./pure-targets.ts";
import { reviewedRuntimeWitnesses } from "./runtime-witnesses.ts";

const TICKET_NAME = "mutation-validation-ticket.json";
const SHA256 = /^[a-f0-9]{64}$/;
const PATH_ENV = "SUBKIT_MUTATION_PARENT_TICKET_PATH";
const SHA_ENV = "SUBKIT_MUTATION_PARENT_TICKET_SHA256";
const ORIGINAL_REPO_ENV = "SUBKIT_MUTATION_ORIGINAL_REPO";
const FILE_STAMP_DIRECTORY = "validation-stamps";

type PathDigest = { path: string; sha256: string };
type TicketShard = Pick<
  MutationWaveManifest["shards"][number],
  "id" | "targets" | "tests" | "consumers" | "resource_tags"
>;

export interface MutationValidationTicket {
  version: 1;
  wave_id: string;
  run_id: string;
  parent_run_root: string;
  original_repo: string;
  manifest_path: string;
  manifest_sha256: string;
  manifest_semantic_sha256: string;
  source_freeze_sha256: string;
  test_freeze_sha256: string;
  config_sha256: string;
  lock_sha256: string;
  equivalence_manifest_sha256: string;
  dynamic_import_ledger_sha256: string;
  quality_policy_sha256?: string;
  target_digest_sha256: string;
  target_inventory_sha256: string;
  target_inventory: readonly PureTargetEntry[];
  runtime_input_paths_sha256: string;
  runtime_input_source_sha256: string;
  runtime_snapshot_path: string;
  runtime_snapshot_sha256: string;
  runtime_snapshot_seal_sha256: string;
  runtime_artifact_digest_sha256: string;
  closure_paths_sha256: string;
  closure_source_sha256: string;
  closure_sha256: string;
  ownership_sha256: string;
  patch_provenance_sha256: string;
  patch_inputs: readonly PathDigest[];
  runtime_inputs: readonly string[];
  closure_files: readonly string[];
  test_paths: readonly string[];
  test_paths_sha256: string;
  shards: readonly TicketShard[];
}

export interface MutationValidationTicketInput {
  repo: string;
  parentRunRoot: string;
  copiedManifestPath: string;
  manifestText: string;
  wave: MutationWaveManifest;
  entries: readonly PureTargetEntry[];
  runId: string;
  runtimeInputs: readonly string[];
  closureFiles: readonly string[];
  runtimeSnapshot: {
    path: string;
    sha256: string;
    sealSha256: string;
    snapshot: MutationRuntimeSnapshot;
  };
}

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const listHash = (values: readonly string[]) => digestCanonical(sorted(values));

function canonicalRepoPath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function noSymlinkComponents(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[/\\]/).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`mutation validation ticket path traverses symlink: ${path}`);
  }
}

function regularFile(path: string, label: string): string {
  noSymlinkComponents(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} must be a regular non-symlink file`);
  return realpathSync(path);
}

function regularDirectory(path: string, label: string): string {
  noSymlinkComponents(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory`);
  return realpathSync(path);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function expectedRunRoot(repo: string, wave: MutationWaveManifest, runId: string): string {
  return join(repo, "reports", "mutation", "runs", wave.wave_id, runId);
}

function assertBoundFiles(repo: string, paths: readonly string[], label: string): void {
  const root = realpathSync(repo);
  for (const path of paths) {
    if (!canonicalRepoPath(path)) throw new Error(`${label} has non-canonical repository path`);
    const file = regularFile(join(root, path), label);
    const fromRoot = relative(root, file);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
      throw new Error(`${label} escapes original repository`);
  }
}

function boundFileState(repo: string, paths: readonly string[]): string {
  const root = realpathSync(repo);
  const hash = createHash("sha256");
  for (const path of sorted(paths)) {
    if (!canonicalRepoPath(path)) throw new Error("bound file has non-canonical repository path");
    const stat = lstatSync(join(root, path), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("bound file must be a regular non-symlink file");
    hash.update(
      `${path}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\0`,
    );
  }
  return hash.digest("hex");
}

function fileStampPath(ticketPath: string, ticketSha256: string): string {
  return join(dirname(ticketPath), FILE_STAMP_DIRECTORY, `${ticketSha256}.json`);
}

function fileStampMatches(path: string, ticketSha256: string, state: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const stamp = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return (
      stamp.version === 1 &&
      stamp.ticket_sha256 === ticketSha256 &&
      stamp.file_state_sha256 === state
    );
  } catch {
    return false;
  }
}

function writeFileStamp(path: string, ticketSha256: string, state: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${process.pid}.pending`;
  writeFileSync(
    pending,
    `${JSON.stringify({ version: 1, ticket_sha256: ticketSha256, file_state_sha256: state })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  renameSync(pending, path);
}

function safeRepoRead(repo: string, path: string): string | null {
  try {
    if (!canonicalRepoPath(path)) return null;
    const root = realpathSync(repo);
    const file = regularFile(join(root, path), "runtime witness input");
    const fromRoot = relative(root, file);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function validateRuntimeWitnessLedger(input: {
  repo: string;
  files: readonly string[];
  ledgerPath: string;
}): void {
  const ledgerText = safeRepoRead(input.repo, input.ledgerPath);
  if (ledgerText === null)
    throw new Error("parent mutation validation ticket runtime ledger is unavailable");
  let ledger: unknown;
  try {
    ledger = JSON.parse(ledgerText);
  } catch {
    throw new Error("parent mutation validation ticket runtime ledger is not valid JSON");
  }
  const reviewed = reviewedRuntimeWitnesses({
    ledger,
    files: input.files,
    readText: (path) => safeRepoRead(input.repo, path),
    readArtifact: (path) => safeRepoRead(input.repo, path),
  });
  if (reviewed.errors.length > 0)
    throw new Error(
      `parent mutation validation ticket runtime witness differs: ${reviewed.errors.join("; ")}`,
    );
}

function semanticHash(text: string): string {
  try {
    return digestCanonical(JSON.parse(text));
  } catch {
    throw new Error("mutation validation ticket manifest is not valid JSON");
  }
}

function patchInputs(repo: string): PathDigest[] {
  return sorted(["package.json", "bun.lock", ...patchedDependencyInputs(repo)]).map((path) => ({
    path,
    sha256: sha(readFileSync(join(repo, path))),
  }));
}

function patchHash(entries: readonly PathDigest[]): string {
  return digestCanonical(entries.map((entry) => [entry.path, entry.sha256]));
}

function shards(wave: MutationWaveManifest): TicketShard[] {
  return wave.shards.map(({ id, targets, tests, consumers, resource_tags }) => ({
    id,
    targets: [...targets],
    tests,
    consumers,
    resource_tags: [...resource_tags],
  }));
}

function ticketText(ticket: MutationValidationTicket): string {
  return `${JSON.stringify(ticket, null, 2)}\n`;
}

export function createMutationValidationTicket(
  input: MutationValidationTicketInput,
): MutationValidationTicket {
  noSymlinkComponents(input.repo);
  const repo = realpathSync(input.repo);
  const parentRunRoot = regularDirectory(input.parentRunRoot, "parent mutation run root");
  if (parentRunRoot !== expectedRunRoot(repo, input.wave, input.runId))
    throw new Error("parent mutation run root differs from owned mutation run path");
  const manifestPath = regularFile(input.copiedManifestPath, "copied mutation manifest");
  if (dirname(manifestPath) !== parentRunRoot)
    throw new Error("copied mutation manifest must be directly inside the parent run root");
  if (readFileSync(manifestPath, "utf8") !== input.manifestText)
    throw new Error("copied mutation manifest bytes differ from the parent preflight");
  const runtimeInputs = sorted(input.runtimeInputs);
  const closureFiles = sorted(input.closureFiles);
  if (!runtimeInputs.every(canonicalRepoPath) || !closureFiles.every(canonicalRepoPath))
    throw new Error("mutation validation ticket contains non-canonical repository paths");
  const literalShards = shards(input.wave);
  const patch = patchInputs(repo);
  const currentRuntimeInputs = mutationTestInputs(repo);
  const currentClosureFiles = mutationClosureFiles(repo);
  const testPaths = sorted(
    input.wave.shards.flatMap((shard) => shard.tests.map((test) => test.path)),
  );
  assertBoundFiles(repo, runtimeInputs, "runtime input");
  assertBoundFiles(repo, closureFiles, "closure input");
  assertBoundFiles(repo, testPaths, "test input");
  if (
    !sameList(runtimeInputs, currentRuntimeInputs) ||
    !sameList(closureFiles, currentClosureFiles)
  )
    throw new Error(
      "parent mutation validation ticket input inventory differs from fresh preflight",
    );
  if (
    input.wave.runtime_artifact_digest_sha256 === undefined ||
    input.runtimeSnapshot.snapshot.artifact_digest_sha256 !==
      input.wave.runtime_artifact_digest_sha256 ||
    input.runtimeSnapshot.snapshot.source_freeze_sha256 !== input.wave.source_freeze_sha256 ||
    input.runtimeSnapshot.snapshot.manifest_sha256 !== sha(input.manifestText) ||
    input.runtimeSnapshot.snapshot.wave_id !== input.wave.wave_id ||
    input.runtimeSnapshot.snapshot.run_id !== input.runId
  )
    throw new Error("parent mutation validation ticket runtime snapshot differs from frozen wave");
  validateRuntimeWitnessLedger({
    repo,
    files: closureFiles,
    ledgerPath: input.wave.dynamic_import_ledger_path,
  });
  if (
    digestWaveFiles(repo, runtimeInputs) !== input.wave.source_freeze_sha256 ||
    digestWaveFiles(repo, testPaths) !== input.wave.test_freeze_sha256 ||
    digestWaveFiles(repo, ["stryker.config.json"]) !== input.wave.config_sha256 ||
    digestWaveFiles(repo, ["bun.lock"]) !== input.wave.lock_sha256 ||
    digestWaveFiles(repo, [input.wave.equivalence_manifest_path]) !==
      input.wave.equivalence_manifest_sha256 ||
    digestWaveFiles(repo, [input.wave.dynamic_import_ledger_path]) !==
      input.wave.dynamic_import_ledger_sha256 ||
    (input.wave.quality_policy_sha256 !== undefined &&
      digestWaveFiles(repo, ["apps/engine/.quality-shard-policy.json"]) !==
        input.wave.quality_policy_sha256)
  )
    throw new Error(
      "parent mutation validation ticket issuance freeze differs from validated wave",
    );
  return {
    version: 1,
    wave_id: input.wave.wave_id,
    run_id: input.runId,
    parent_run_root: parentRunRoot,
    original_repo: repo,
    manifest_path: manifestPath,
    manifest_sha256: sha(input.manifestText),
    manifest_semantic_sha256: semanticHash(input.manifestText),
    source_freeze_sha256: input.wave.source_freeze_sha256,
    test_freeze_sha256: input.wave.test_freeze_sha256,
    config_sha256: input.wave.config_sha256,
    lock_sha256: input.wave.lock_sha256,
    equivalence_manifest_sha256: input.wave.equivalence_manifest_sha256,
    dynamic_import_ledger_sha256: input.wave.dynamic_import_ledger_sha256,
    ...(input.wave.quality_policy_sha256 === undefined
      ? {}
      : { quality_policy_sha256: input.wave.quality_policy_sha256 }),
    target_digest_sha256: input.wave.target_digest_sha256,
    target_inventory_sha256: digestCanonical(input.entries),
    target_inventory: input.entries,
    runtime_input_paths_sha256: listHash(runtimeInputs),
    runtime_input_source_sha256: digestWaveFiles(repo, runtimeInputs),
    runtime_snapshot_path: relative(repo, input.runtimeSnapshot.path),
    runtime_snapshot_sha256: input.runtimeSnapshot.sha256,
    runtime_snapshot_seal_sha256: input.runtimeSnapshot.sealSha256,
    runtime_artifact_digest_sha256: input.runtimeSnapshot.snapshot.artifact_digest_sha256,
    closure_paths_sha256: listHash(closureFiles),
    closure_source_sha256: digestWaveFiles(repo, closureFiles),
    closure_sha256: digestCanonical(literalShards),
    ownership_sha256: digestCanonical(
      literalShards.flatMap((shard) => shard.targets.map((target) => [target, shard.id])),
    ),
    patch_provenance_sha256: patchHash(patch),
    patch_inputs: patch,
    runtime_inputs: runtimeInputs,
    closure_files: closureFiles,
    test_paths: testPaths,
    test_paths_sha256: listHash(testPaths),
    shards: literalShards,
  };
}

export function writeMutationValidationTicket(input: MutationValidationTicketInput): {
  path: string;
  sha256: string;
  text: string;
  ticket: MutationValidationTicket;
} {
  mkdirSync(input.parentRunRoot, { recursive: true });
  const parentRunRoot = regularDirectory(input.parentRunRoot, "parent mutation run root");
  const ticket = createMutationValidationTicket(input);
  const text = ticketText(ticket);
  const path = join(parentRunRoot, TICKET_NAME);
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  const written = regularFile(path, "parent mutation validation ticket");
  if (readFileSync(written, "utf8") !== text)
    throw new Error("parent mutation validation ticket changed after creation");
  return { path: written, sha256: sha(text), text, ticket };
}

function inherited(env: NodeJS.ProcessEnv): { path: string; sha256: string; repo: string } | null {
  const path = env[PATH_ENV];
  const sha256 = env[SHA_ENV];
  if (path === undefined && sha256 === undefined) return null;
  const repo = env[ORIGINAL_REPO_ENV];
  if (!path || !sha256 || !repo || !SHA256.test(sha256))
    throw new Error("partial or invalid parent mutation validation ticket environment");
  return { path, sha256, repo };
}

function readTicket(
  path: string,
  expectedSha: string,
): { ticket: MutationValidationTicket; path: string } {
  const regular = regularFile(path, "parent mutation validation ticket");
  const text = readFileSync(regular, "utf8");
  if (sha(text) !== expectedSha)
    throw new Error("parent mutation validation ticket sha256 differs");
  let ticket: unknown;
  try {
    ticket = JSON.parse(text);
  } catch {
    throw new Error("parent mutation validation ticket is not valid JSON");
  }
  if (!ticket || typeof ticket !== "object")
    throw new Error("parent mutation validation ticket is invalid");
  return { ticket: ticket as MutationValidationTicket, path: regular };
}

function assertTicketShape(ticket: MutationValidationTicket, ticketPath: string): void {
  if (
    ticket.version !== 1 ||
    !SHA256.test(ticket.manifest_sha256) ||
    !SHA256.test(ticket.manifest_semantic_sha256)
  )
    throw new Error("parent mutation validation ticket has invalid version or digest");
  if (
    !isAbsolute(ticket.parent_run_root) ||
    !isAbsolute(ticket.original_repo) ||
    !isAbsolute(ticket.manifest_path)
  )
    throw new Error("parent mutation validation ticket has non-absolute paths");
  const root = realpathSync(ticket.parent_run_root);
  if (dirname(ticketPath) !== root || dirname(ticket.manifest_path) !== root)
    throw new Error("parent mutation validation ticket escapes its parent run root");
  if (
    !Array.isArray(ticket.runtime_inputs) ||
    !Array.isArray(ticket.closure_files) ||
    !Array.isArray(ticket.target_inventory) ||
    !Array.isArray(ticket.shards)
  )
    throw new Error("parent mutation validation ticket is missing bound inputs");
  if (
    !ticket.runtime_inputs.every(canonicalRepoPath) ||
    !ticket.closure_files.every(canonicalRepoPath) ||
    !Array.isArray(ticket.test_paths) ||
    !ticket.test_paths.every(canonicalRepoPath) ||
    !SHA256.test(ticket.test_paths_sha256) ||
    !SHA256.test(ticket.target_inventory_sha256) ||
    digestCanonical(ticket.target_inventory) !== ticket.target_inventory_sha256
  )
    throw new Error("parent mutation validation ticket has non-canonical inputs");
  if (
    !canonicalRepoPath(ticket.runtime_snapshot_path) ||
    !ticket.runtime_snapshot_path.startsWith("reports/mutation/runs/") ||
    !SHA256.test(ticket.runtime_snapshot_sha256) ||
    !SHA256.test(ticket.runtime_snapshot_seal_sha256) ||
    !SHA256.test(ticket.runtime_artifact_digest_sha256)
  )
    throw new Error("parent mutation validation ticket has invalid runtime snapshot");
}

function equal(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`parent mutation validation ticket ${label} differs`);
}

export function validateParentMutationValidationTicket(input: {
  repo: string;
  manifestPath: string;
  shardId?: string;
  sandboxRepo?: string;
  env?: NodeJS.ProcessEnv;
  reuseFileStamp?: boolean;
}): {
  ticket: MutationValidationTicket;
  wave: MutationWaveManifest;
  manifestText: string;
  ticketSha256: string;
  reusedFileStamp: boolean;
} | null {
  const parent = inherited(input.env ?? process.env);
  if (!parent) return null;
  const loaded = readTicket(parent.path, parent.sha256);
  const { ticket } = loaded;
  assertTicketShape(ticket, loaded.path);
  const original = realpathSync(parent.repo);
  if (original !== ticket.original_repo || realpathSync(input.repo) !== ticket.original_repo)
    throw new Error("parent mutation validation ticket original repository differs");
  if (input.sandboxRepo !== undefined && realpathSync(input.sandboxRepo) === original)
    throw new Error(
      "parent mutation validation ticket sandbox must differ from original repository",
    );
  const manifestPath = regularFile(input.manifestPath, "child mutation manifest");
  if (manifestPath !== ticket.manifest_path)
    throw new Error("parent mutation validation ticket manifest path differs");
  const manifestText = readFileSync(manifestPath, "utf8");
  equal(sha(manifestText), ticket.manifest_sha256, "manifest bytes");
  equal(semanticHash(manifestText), ticket.manifest_semantic_sha256, "manifest semantics");
  const wave = JSON.parse(manifestText) as MutationWaveManifest;
  if (
    wave.wave_id !== ticket.wave_id ||
    wave.source_freeze_sha256 !== ticket.source_freeze_sha256 ||
    wave.test_freeze_sha256 !== ticket.test_freeze_sha256 ||
    wave.config_sha256 !== ticket.config_sha256 ||
    wave.lock_sha256 !== ticket.lock_sha256 ||
    wave.equivalence_manifest_sha256 !== ticket.equivalence_manifest_sha256 ||
    wave.dynamic_import_ledger_sha256 !== ticket.dynamic_import_ledger_sha256 ||
    wave.runtime_artifact_digest_sha256 !== ticket.runtime_artifact_digest_sha256 ||
    wave.quality_policy_sha256 !== ticket.quality_policy_sha256 ||
    wave.target_digest_sha256 !== ticket.target_digest_sha256 ||
    digestCanonical(ticket.target_inventory.map((entry) => entry.path).sort()) !==
      digestCanonical(
        shards(wave)
          .flatMap((shard) => shard.targets)
          .sort(),
      ) ||
    digestCanonical(shards(wave)) !== ticket.closure_sha256
  )
    throw new Error("parent mutation validation ticket wave binding differs");
  if (
    wave.runtime_artifact_digest_sha256 === undefined ||
    wave.runtime_artifact_digest_sha256 !== ticket.runtime_artifact_digest_sha256 ||
    !ticket.runtime_snapshot_path.startsWith("reports/mutation/runs/")
  )
    throw new Error("parent mutation validation ticket runtime snapshot binding differs");
  assertMutationRuntimeSnapshotFast({
    path: join(original, ticket.runtime_snapshot_path),
    sha256: ticket.runtime_snapshot_sha256,
    expected: {
      wave_id: wave.wave_id,
      run_id: ticket.run_id,
      source_freeze_sha256: wave.source_freeze_sha256,
      manifest_sha256: ticket.manifest_sha256,
      artifact_digest_sha256: ticket.runtime_artifact_digest_sha256,
    },
  });
  if (input.shardId !== undefined) {
    const shard = shards(wave).find((candidate) => candidate.id === input.shardId);
    const expected = ticket.shards.find((candidate) => candidate.id === input.shardId);
    if (!shard || !expected || digestCanonical(shard) !== digestCanonical(expected))
      throw new Error("parent mutation validation ticket selected shard differs");
  }
  const runtimeInputs = mutationTestInputs(original);
  const closureFiles = mutationClosureFiles(original);
  if (!sameList(runtimeInputs, ticket.runtime_inputs))
    throw new Error("parent mutation validation ticket runtime input inventory differs");
  if (!sameList(closureFiles, ticket.closure_files))
    throw new Error("parent mutation validation ticket closure input inventory differs");
  const stampPath = fileStampPath(loaded.path, parent.sha256);
  const fileState = input.reuseFileStamp
    ? boundFileState(original, [...runtimeInputs, ...closureFiles, ...ticket.test_paths])
    : undefined;
  const reusedFileStamp =
    fileState !== undefined && fileStampMatches(stampPath, parent.sha256, fileState);
  if (!reusedFileStamp) {
    assertBoundFiles(original, runtimeInputs, "runtime input");
    assertBoundFiles(original, closureFiles, "closure input");
    assertBoundFiles(original, ticket.test_paths, "test input");
  }
  validateRuntimeWitnessLedger({
    repo: original,
    files: closureFiles,
    ledgerPath: wave.dynamic_import_ledger_path,
  });
  equal(listHash(runtimeInputs), ticket.runtime_input_paths_sha256, "runtime input paths");
  if (!reusedFileStamp) {
    equal(
      digestWaveFiles(original, runtimeInputs),
      ticket.runtime_input_source_sha256,
      "runtime source bytes",
    );
    equal(
      digestWaveFiles(original, closureFiles),
      ticket.closure_source_sha256,
      "closure source bytes",
    );
  }
  const patch = patchInputs(original);
  if (JSON.stringify(patch) !== JSON.stringify(ticket.patch_inputs))
    throw new Error("parent mutation validation ticket patch input inventory differs");
  equal(patchHash(patch), ticket.patch_provenance_sha256, "patch provenance");
  const tests = sorted(wave.shards.flatMap((shard) => shard.tests.map((test) => test.path)));
  equal(listHash(tests), ticket.test_paths_sha256, "test path inventory");
  if (JSON.stringify(tests) !== JSON.stringify(ticket.test_paths))
    throw new Error("parent mutation validation ticket test paths differ");
  if (!reusedFileStamp)
    equal(digestWaveFiles(original, tests), ticket.test_freeze_sha256, "test bytes");
  equal(digestWaveFiles(original, ["stryker.config.json"]), ticket.config_sha256, "config bytes");
  equal(digestWaveFiles(original, ["bun.lock"]), ticket.lock_sha256, "lock bytes");
  equal(
    digestWaveFiles(original, [wave.equivalence_manifest_path]),
    ticket.equivalence_manifest_sha256,
    "equivalence bytes",
  );
  equal(
    digestWaveFiles(original, [wave.dynamic_import_ledger_path]),
    ticket.dynamic_import_ledger_sha256,
    "runtime ledger bytes",
  );
  if (wave.quality_policy_sha256 !== undefined)
    equal(
      digestWaveFiles(original, ["apps/engine/.quality-shard-policy.json"]),
      wave.quality_policy_sha256,
      "quality policy bytes",
    );
  if (fileState !== undefined && !reusedFileStamp)
    writeFileStamp(stampPath, parent.sha256, fileState);
  return { ticket, wave, manifestText, ticketSha256: parent.sha256, reusedFileStamp };
}
