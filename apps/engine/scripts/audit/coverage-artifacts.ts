import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export interface InputSnapshot {
  files: string[];
  sha256: string;
}

export interface CoverageRunLease {
  coverageDir: string;
  rawDir: string;
  runId: string;
  leasePath: string;
  leaseToken: string;
  nextInvocation: () => string;
}

export interface DirectTargetProof {
  target: string;
  relativePath: string;
  lcov: string;
  sha256: string;
}

interface ReceiptFile {
  path: string;
  sha256: string;
}

interface CoverageReceipt {
  version: 1;
  run_id: string;
  completed_at: string;
  lcov: ReceiptFile;
  provenance: ReceiptFile;
  direct_target_evidence: Array<{ target: string; path: string; sha256: string }>;
}

interface LatestCoveragePointer {
  version: 1;
  run_id: string;
  receipt: string;
  receipt_sha256: string;
  published_at: string;
}

export interface PublishedCoverage {
  runId: string;
  runDir: string;
  lcovPath: string;
  provenancePath: string;
  receiptPath: string;
  latestPath: string;
  latestContents: string;
  targetProofPaths: string[];
}

const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");
const activeLeaseTokens = new Map<string, string>();

function writeJson(path: string, value: unknown): void {
  durableWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function durableWrite(path: string, content: string): void {
  writeFileSync(path, content);
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (!(error instanceof Error) || !/(EINVAL|EPERM)/.test(error.message)) throw error;
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomically(path: string, content: string): void {
  const temp = join(resolve(path, ".."), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  durableWrite(temp, content);
  renameSync(temp, path);
  syncDirectory(resolve(path, ".."));
}

function safeRunPath(coverageDir: string, relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes(".."))
    throw new Error(`unsafe coverage receipt path: ${relativePath}`);
  const path = resolve(coverageDir, relativePath);
  const root = `${resolve(coverageDir)}${sep}`;
  if (!path.startsWith(root))
    throw new Error(`coverage receipt path escapes coverage directory: ${relativePath}`);
  return path;
}

function readRegularFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`coverage receipt requires a regular file: ${path}`);
  return readFileSync(path, "utf8");
}

function validateRunId(runId: string): void {
  if (!/^[a-z0-9-]{10,200}$/.test(runId)) throw new Error("coverage receipt has an invalid run id");
}

function requireOwnedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`coverage lease requires an owned directory: ${path}`);
}

function requireNoSymlinkChildren(root: string, path: string): void {
  const relativePath = relative(root, path);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    relativePath.split(/[\\/]/).includes("..")
  )
    throw new Error(`coverage receipt path escapes canonical root: ${path}`);
  let current = root;
  for (const part of relativePath.split(/[\\/]/)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink())
      throw new Error(`coverage receipt must not traverse a symbolic link: ${current}`);
  }
}

export function clearPreviousLcov(rawDir: string): string {
  mkdirSync(rawDir, { recursive: true });
  const lcovPath = join(rawDir, "lcov.info");
  rmSync(lcovPath, { force: true });
  return lcovPath;
}

export function createCoverageRunLease(coverageDir: string, now = new Date()): CoverageRunLease {
  const rawRuns = join(coverageDir, "raw", "runs");
  mkdirSync(rawRuns, { recursive: true });
  const runId = `${now.getTime().toString(36)}-${process.pid}-${randomUUID()}`;
  const rawDir = join(rawRuns, runId);
  mkdirSync(rawDir);
  const leasePath = join(rawDir, "lease.json");
  const leaseToken = randomUUID();
  writeJson(leasePath, {
    version: 1,
    kind: "subkit-coverage-raw-run",
    run_id: runId,
    state: "running",
    created_at: now.toISOString(),
    owner_pid: process.pid,
    lease_token: leaseToken,
  });
  activeLeaseTokens.set(rawDir, leaseToken);
  let sequence = 0;
  return {
    coverageDir,
    rawDir,
    runId,
    leasePath,
    leaseToken,
    nextInvocation: () =>
      join(rawDir, "invocations", `${String(sequence++).padStart(5, "0")}-${randomUUID()}`),
  };
}

export function prepareRawLcov(lease: CoverageRunLease): string {
  const invocationDir = lease.nextInvocation();
  mkdirSync(invocationDir, { recursive: true });
  return join(invocationDir, "lcov.info");
}

export function retainCoverageRawRun(
  lease: CoverageRunLease,
  state: "failed" | "debug",
  reason: string,
  now = new Date(),
): void {
  const retentionUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
  writeJson(lease.leasePath, {
    version: 1,
    kind: "subkit-coverage-raw-run",
    run_id: lease.runId,
    lease_token: lease.leaseToken,
    owner_pid: process.pid,
    state,
    retained_at: now.toISOString(),
    retention_until: retentionUntil.toISOString(),
    reason,
  });
}

export function installCoverageLeaseSignalRetention(lease: CoverageRunLease): () => void {
  let active = true;
  const retain = (signal: "SIGINT" | "SIGTERM") => {
    try {
      if (active)
        retainCoverageRawRun(lease, "failed", `coverage process interrupted by ${signal}`);
    } catch {}
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onInterrupt = () => retain("SIGINT");
  const onTerminate = () => retain("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  return () => {
    active = false;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  };
}

export function removeCoverageRawRunAfterReceipt(lease: CoverageRunLease): void {
  readImmutableCoverageRun(lease.coverageDir, lease.runId);
  const ownedRoot = join(lease.coverageDir, "raw", "runs");
  const expectedRawDir = join(ownedRoot, lease.runId);
  if (resolve(lease.rawDir) !== resolve(expectedRawDir) || basename(lease.rawDir) !== lease.runId)
    throw new Error(
      `refusing to remove coverage raw directory outside owned runs root: ${lease.rawDir}`,
    );
  requireOwnedDirectory(ownedRoot);
  requireOwnedDirectory(lease.rawDir);
  const expectedToken = activeLeaseTokens.get(lease.rawDir);
  const marker = JSON.parse(readRegularFile(lease.leasePath)) as {
    run_id?: unknown;
    lease_token?: unknown;
    state?: unknown;
  };
  if (
    expectedToken !== lease.leaseToken ||
    marker.run_id !== lease.runId ||
    marker.lease_token !== lease.leaseToken ||
    marker.state !== "running"
  )
    throw new Error(`refusing to remove an unowned or finalized coverage raw run: ${lease.rawDir}`);
  rmSync(lease.rawDir, { recursive: true, force: true });
  activeLeaseTokens.delete(lease.rawDir);
}

export function createDirectTargetProof(target: string, lcov: string): DirectTargetProof {
  const targetHash = sha256(target);
  return { target, relativePath: `targets/${targetHash}.lcov`, lcov, sha256: sha256(lcov) };
}

export async function publishCoverageReceipt(input: {
  coverageDir: string;
  lease: CoverageRunLease;
  lcov: string;
  provenance: Record<string, unknown>;
  directTargetProofs: readonly DirectTargetProof[];
}): Promise<PublishedCoverage> {
  const { lease, lcov, provenance, directTargetProofs } = input;
  const coverageDir = realpathSync(input.coverageDir);
  const runsDir = join(coverageDir, "runs");
  mkdirSync(runsDir, { recursive: true });
  const stagingDir = join(runsDir, `.staging-${lease.runId}`);
  const runDir = join(runsDir, lease.runId);
  if (existsSync(stagingDir) || existsSync(runDir))
    throw new Error(`coverage receipt run already exists: ${lease.runId}`);
  mkdirSync(join(stagingDir, "targets"), { recursive: true });
  const lcovPath = join(stagingDir, "lcov.info");
  const provenancePath = join(stagingDir, "provenance.json");
  durableWrite(lcovPath, lcov);
  writeJson(provenancePath, provenance);
  for (const proof of directTargetProofs) {
    const path = safeRunPath(stagingDir, proof.relativePath);
    mkdirSync(resolve(path, ".."), { recursive: true });
    durableWrite(path, proof.lcov);
  }
  const receipt: CoverageReceipt = {
    version: 1,
    run_id: lease.runId,
    completed_at: new Date().toISOString(),
    lcov: { path: "lcov.info", sha256: sha256(lcov) },
    provenance: { path: "provenance.json", sha256: sha256(readFileSync(provenancePath)) },
    direct_target_evidence: directTargetProofs.map((proof) => ({
      target: proof.target,
      path: proof.relativePath,
      sha256: proof.sha256,
    })),
  };
  const receiptPath = join(stagingDir, "receipt.json");
  writeJson(receiptPath, receipt);
  syncDirectory(join(stagingDir, "targets"));
  syncDirectory(stagingDir);
  renameSync(stagingDir, runDir);
  syncDirectory(runsDir);
  const immutableReceiptPath = join(runDir, "receipt.json");
  const immutableReceipt = readFileSync(immutableReceiptPath, "utf8");
  const pointer: LatestCoveragePointer = {
    version: 1,
    run_id: lease.runId,
    receipt: relative(coverageDir, immutableReceiptPath),
    receipt_sha256: sha256(immutableReceipt),
    published_at: new Date().toISOString(),
  };
  writeAtomically(join(coverageDir, "latest.json"), `${JSON.stringify(pointer, null, 2)}\n`);
  return readImmutableCoverageRun(coverageDir, lease.runId, {
    latestPath: join(coverageDir, "latest.json"),
    latestContents: `${JSON.stringify(pointer, null, 2)}\n`,
    receiptText: immutableReceipt,
  });
}

export function readPublishedCoverage(coverageDir: string): PublishedCoverage {
  const canonicalCoverageDir = realpathSync(coverageDir);
  const latestPath = join(canonicalCoverageDir, "latest.json");
  const latestContents = readRegularFile(latestPath);
  const pointer = JSON.parse(latestContents) as LatestCoveragePointer;
  if (
    pointer.version !== 1 ||
    typeof pointer.run_id !== "string" ||
    typeof pointer.receipt !== "string"
  )
    throw new Error("coverage latest pointer has an invalid schema");
  validateRunId(pointer.run_id);
  const expectedReceipt = `runs/${pointer.run_id}/receipt.json`;
  if (pointer.receipt !== expectedReceipt)
    throw new Error("coverage latest pointer has an unexpected receipt path");
  const receiptPath = safeRunPath(canonicalCoverageDir, pointer.receipt);
  requireNoSymlinkChildren(canonicalCoverageDir, receiptPath);
  const receiptText = readRegularFile(receiptPath);
  if (sha256(receiptText) !== pointer.receipt_sha256)
    throw new Error("coverage latest pointer receipt hash mismatch");
  return readImmutableCoverageRun(canonicalCoverageDir, pointer.run_id, {
    latestPath,
    latestContents,
    receiptText,
  });
}

function readImmutableCoverageRun(
  coverageDir: string,
  runId: string,
  pointer?: { latestPath: string; latestContents: string; receiptText: string },
): PublishedCoverage {
  validateRunId(runId);
  const runDir = join(coverageDir, "runs", runId);
  const receiptPath = join(runDir, "receipt.json");
  requireNoSymlinkChildren(coverageDir, receiptPath);
  const receiptText = pointer?.receiptText ?? readRegularFile(receiptPath);
  const receipt = JSON.parse(receiptText) as CoverageReceipt;
  if (receipt.version !== 1 || receipt.run_id !== runId)
    throw new Error("coverage receipt does not match run id");
  const validate = (file: ReceiptFile, expectedPath: "lcov.info" | "provenance.json"): string => {
    if (!file || file.path !== expectedPath || typeof file.sha256 !== "string")
      throw new Error(`coverage receipt has an unexpected ${expectedPath} evidence path`);
    const path = safeRunPath(runDir, file.path);
    if (sha256(readRegularFile(path)) !== file.sha256)
      throw new Error(`coverage receipt hash mismatch: ${file.path}`);
    return path;
  };
  const lcovPath = validate(receipt.lcov, "lcov.info");
  const provenancePath = validate(receipt.provenance, "provenance.json");
  if (!Array.isArray(receipt.direct_target_evidence))
    throw new Error("coverage receipt has invalid direct target evidence");
  const seenTargets = new Set<string>();
  const seenProofPaths = new Set<string>();
  const targetProofPaths = receipt.direct_target_evidence.map((proof) => {
    if (
      typeof proof.target !== "string" ||
      typeof proof.path !== "string" ||
      typeof proof.sha256 !== "string" ||
      seenTargets.has(proof.target)
    )
      throw new Error("coverage receipt has duplicate or invalid direct target evidence");
    seenTargets.add(proof.target);
    if (!/^targets\/[a-f0-9]{64}\.lcov$/.test(proof.path) || seenProofPaths.has(proof.path))
      throw new Error("coverage receipt has an invalid direct target proof path");
    seenProofPaths.add(proof.path);
    const path = safeRunPath(runDir, proof.path);
    requireNoSymlinkChildren(runDir, path);
    if (sha256(readRegularFile(path)) !== proof.sha256)
      throw new Error(`coverage direct target proof hash mismatch: ${proof.target}`);
    return path;
  });
  const provenance = JSON.parse(readRegularFile(provenancePath)) as {
    direct_target_evidence?: unknown;
  };
  if (
    JSON.stringify(provenance.direct_target_evidence) !==
    JSON.stringify(receipt.direct_target_evidence)
  )
    throw new Error("coverage provenance direct target evidence does not match its receipt");
  return {
    runId,
    runDir,
    lcovPath,
    provenancePath,
    receiptPath,
    latestPath: pointer?.latestPath ?? "",
    latestContents: pointer?.latestContents ?? "",
    targetProofPaths,
  };
}

export function snapshotInputs(repo: string, files: readonly string[]): InputSnapshot {
  const hash = createHash("sha256");
  const sorted = [...new Set(files)].sort();
  for (const file of sorted) {
    if (!existsSync(join(repo, file))) throw new Error(`coverage input no longer exists: ${file}`);
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(repo, file)));
    hash.update("\0");
  }
  return { files: sorted, sha256: hash.digest("hex") };
}

export function inputsChanged(before: InputSnapshot, after: InputSnapshot): boolean {
  return before.sha256 !== after.sha256 || before.files.join("\0") !== after.files.join("\0");
}
