import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MANIFEST = "manifest.json";
const FORMAT = "subkit-verification-run";
const VERSION = 1;

export const verificationRunsRoot = (repositoryRoot: string) =>
  join(resolve(repositoryRoot), ".artifacts", "goal-verification", "runs");

export type RetentionClass = "regular" | "failure" | "debug" | "release" | "pinned" | "historical";
export type RunStatus = "running" | "passed" | "failed" | "cancelled";

export type VerificationRunManifest = Readonly<{
  format: typeof FORMAT;
  version: typeof VERSION;
  runId: string;
  owner: string;
  sourceDigest?: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  retention: Readonly<{ class: RetentionClass; expiresAt: string | null }>;
  lease: Readonly<{ pid: number; token: string; acquiredAt: string }>;
  logPath?: string;
  resultPath?: string;
}>;

export type VerificationRun = Readonly<{ directory: string; manifest: VerificationRunManifest }>;
export type VerificationRunHandle = VerificationRun & Readonly<{ leaseToken: string }>;
export type PruneCandidate = Readonly<{
  directory: string;
  runId: string;
  action: "skip" | "remove";
  reason: string;
}>;

export type CreateVerificationRunInput = Readonly<{
  root: string;
  owner: string;
  runId?: string;
  sourceDigest?: string;
  retention?: Exclude<RetentionClass, "historical">;
  logPath?: string;
}>;

export type FinalizeVerificationRunInput = Readonly<{
  status: Exclude<RunStatus, "running">;
  resultPath?: string;
  logPath?: string;
  retention?: RetentionClass;
}>;

export type PruneOptions = Readonly<{
  apply?: boolean;
  now?: Date;
  isPidLive?: (pid: number) => "live" | "dead" | "unknown";
}>;

function timestamp(now = new Date()): string {
  return now.toISOString();
}

function durationFor(retention: RetentionClass): number | undefined {
  if (retention === "regular") return 90 * 24 * 60 * 60 * 1000;
  if (retention === "failure" || retention === "debug") return 30 * 24 * 60 * 60 * 1000;
  return undefined;
}

function expiresAt(retention: RetentionClass, finishedAt: string): string | null {
  const duration = durationFor(retention);
  return duration === undefined
    ? null
    : new Date(new Date(finishedAt).getTime() + duration).toISOString();
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(runId))
    throw new Error("verification run id must contain only lowercase letters, digits, and hyphens");
}

function assertRelativeArtifactPath(value: string | undefined, name: string): void {
  if (value === undefined) return;
  if (!value || value.includes("\0") || value.startsWith("/") || value.startsWith("\\"))
    throw new Error(`${name} must be a non-empty relative path`);
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`${name} must be a normalized relative path`);
}

function ensureDirectory(path: string): void {
  assertNoSymlinkAncestors(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`unsafe verification-run directory: ${path}`);
}

function assertNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`unsafe verification-run symlink ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function atomicWrite(path: string, value: VerificationRunManifest): void {
  const temporary = join(dirname(path), `.${MANIFEST}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {}
  }
}

function manifestPath(directory: string): string {
  return join(directory, MANIFEST);
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`))
    throw new Error("verification run escaped its owned root");
}

function parseManifest(directory: string, expectedRunId?: string): VerificationRunManifest {
  const file = manifestPath(directory);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("verification run manifest is unsafe");
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<VerificationRunManifest>;
  if (
    value.format !== FORMAT ||
    value.version !== VERSION ||
    typeof value.runId !== "string" ||
    typeof value.owner !== "string" ||
    typeof value.startedAt !== "string" ||
    !value.retention ||
    !value.lease ||
    typeof value.lease.pid !== "number" ||
    !Number.isInteger(value.lease.pid) ||
    value.lease.pid < 1 ||
    typeof value.lease.token !== "string" ||
    typeof value.lease.acquiredAt !== "string" ||
    !["running", "passed", "failed", "cancelled"].includes(String(value.status)) ||
    !["regular", "failure", "debug", "release", "pinned", "historical"].includes(
      String(value.retention.class),
    ) ||
    !(value.retention.expiresAt === null || typeof value.retention.expiresAt === "string")
  )
    throw new Error("verification run manifest has an unsupported shape");
  assertRunId(value.runId);
  if (expectedRunId !== undefined && value.runId !== expectedRunId)
    throw new Error("verification run manifest id does not match its directory");
  if (value.finishedAt !== undefined && typeof value.finishedAt !== "string")
    throw new Error("verification run manifest has an invalid finished timestamp");
  const started = new Date(value.startedAt);
  const finished = value.finishedAt === undefined ? undefined : new Date(value.finishedAt);
  if (Number.isNaN(started.getTime()) || (finished && Number.isNaN(finished.getTime())))
    throw new Error("verification run manifest has an invalid timestamp");
  if (
    value.status === "running" &&
    (value.finishedAt !== undefined || value.retention.expiresAt !== null)
  )
    throw new Error("running verification run has terminal retention");
  if (value.status !== "running" && (!finished || finished.getTime() < started.getTime()))
    throw new Error("completed verification run has an invalid finished timestamp");
  const retention = value.retention.class as RetentionClass;
  const expectedExpiry = finished === undefined ? null : expiresAt(retention, value.finishedAt!);
  if (value.status !== "running" && value.retention.expiresAt !== expectedExpiry)
    throw new Error("verification run manifest has an inconsistent expiration");
  assertRelativeArtifactPath(value.logPath, "logPath");
  assertRelativeArtifactPath(value.resultPath, "resultPath");
  return value as VerificationRunManifest;
}

function readOwnedRun(root: string, runId: string): VerificationRun {
  assertRunId(runId);
  ensureDirectory(root);
  const directory = resolve(root, runId);
  assertInside(resolve(root), directory);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("verification run directory is unsafe");
  return { directory, manifest: parseManifest(directory, runId) };
}

function pidLiveness(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

export function createVerificationRun(input: CreateVerificationRunInput): VerificationRunHandle {
  if (!input.owner.trim()) throw new Error("verification run owner is required");
  const root = resolve(input.root);
  ensureDirectory(root);
  const runId = input.runId ?? `run-${randomUUID()}`;
  assertRunId(runId);
  assertRelativeArtifactPath(input.logPath, "logPath");
  const directory = resolve(root, runId);
  assertInside(root, directory);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("verification run directory is unsafe");
  const now = timestamp();
  const retention = input.retention ?? "regular";
  const leaseToken = randomUUID();
  const manifest: VerificationRunManifest = {
    format: FORMAT,
    version: VERSION,
    runId,
    owner: input.owner,
    ...(input.sourceDigest ? { sourceDigest: input.sourceDigest } : {}),
    startedAt: now,
    status: "running",
    retention: { class: retention, expiresAt: null },
    lease: { pid: process.pid, token: leaseToken, acquiredAt: now },
    ...(input.logPath ? { logPath: input.logPath } : {}),
  };
  atomicWrite(manifestPath(directory), manifest);
  return { directory, manifest, leaseToken };
}

export function finalizeVerificationRun(
  handle: VerificationRunHandle,
  input: FinalizeVerificationRunInput,
): VerificationRun {
  if (!handle.leaseToken || !["passed", "failed", "cancelled"].includes(input.status))
    throw new Error("a terminal run status is required");
  const root = dirname(handle.directory);
  const current = readOwnedRun(root, handle.manifest.runId);
  if (current.manifest.lease.token !== handle.leaseToken)
    throw new Error("verification run lease is no longer owned by this caller");
  if (current.manifest.status !== "running")
    throw new Error("verification run is already finalized");
  assertRelativeArtifactPath(input.logPath, "logPath");
  assertRelativeArtifactPath(input.resultPath, "resultPath");
  const retention =
    input.retention ??
    (input.status === "failed" && current.manifest.retention.class === "regular"
      ? "failure"
      : current.manifest.retention.class);
  const finishedAt = timestamp();
  const manifest: VerificationRunManifest = {
    ...current.manifest,
    status: input.status,
    finishedAt,
    retention: { class: retention, expiresAt: expiresAt(retention, finishedAt) },
    ...(input.logPath ? { logPath: input.logPath } : {}),
    ...(input.resultPath ? { resultPath: input.resultPath } : {}),
  };
  atomicWrite(manifestPath(current.directory), manifest);
  return { directory: current.directory, manifest };
}

function candidateFor(
  directory: string,
  runId: string,
  now: Date,
  isPidLive: (pid: number) => "live" | "dead" | "unknown",
): PruneCandidate {
  let manifest: VerificationRunManifest;
  try {
    assertNoSymlinkAncestors(directory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe run directory");
    manifest = parseManifest(directory, runId);
  } catch {
    return { directory, runId, action: "skip", reason: "unrecognized_or_unsafe_manifest" };
  }
  if (manifest.status === "running")
    return { directory, runId, action: "skip", reason: "run_not_completed" };
  if (
    manifest.retention.class === "release" ||
    manifest.retention.class === "pinned" ||
    manifest.retention.class === "historical"
  )
    return { directory, runId, action: "skip", reason: "retention_preserved" };
  if (manifest.retention.expiresAt === null)
    return { directory, runId, action: "skip", reason: "no_expiration" };
  const expiry = new Date(manifest.retention.expiresAt);
  if (Number.isNaN(expiry.getTime()))
    return { directory, runId, action: "skip", reason: "invalid_expiration" };
  if (expiry.getTime() > now.getTime())
    return { directory, runId, action: "skip", reason: "not_expired" };
  const liveness = isPidLive(manifest.lease.pid);
  if (liveness === "live") return { directory, runId, action: "skip", reason: "live_lease" };
  if (liveness === "unknown") return { directory, runId, action: "skip", reason: "unknown_lease" };
  return { directory, runId, action: "remove", reason: "completed_expired_unleased" };
}

function claimAndRemove(
  root: string,
  candidate: PruneCandidate,
  now: Date,
  isPidLive: (pid: number) => "live" | "dead" | "unknown",
): PruneCandidate {
  const claim = join(root, `.${candidate.runId}.pruning-${randomUUID()}`);
  try {
    renameSync(candidate.directory, claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...candidate, action: "skip", reason: "changed_before_claim" };
    throw error;
  }
  try {
    const rechecked = candidateFor(claim, candidate.runId, now, isPidLive);
    if (rechecked.action !== "remove") {
      renameSync(claim, candidate.directory);
      return { ...candidate, action: "skip", reason: `changed_after_claim:${rechecked.reason}` };
    }
    rmSync(claim, { recursive: true, force: false, maxRetries: 1 });
    return candidate;
  } catch (error) {
    try {
      renameSync(claim, candidate.directory);
    } catch {}
    throw error;
  }
}

export function pruneVerificationRuns(
  rootInput: string,
  options: PruneOptions = {},
): readonly PruneCandidate[] {
  const root = resolve(rootInput);
  try {
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`unsafe verification-runs root: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("pruning requires a valid current time");
  const isPidLive = options.isPidLive ?? pidLiveness;
  const candidates = readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const directory = resolve(root, entry.name);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !/^[a-z0-9][a-z0-9-]{0,119}$/.test(entry.name)
      )
        return {
          directory,
          runId: entry.name,
          action: "skip" as const,
          reason: "not_an_owned_run_directory",
        };
      return candidateFor(directory, entry.name, now, isPidLive);
    });
  if (!options.apply) return candidates;
  return candidates.map((candidate) =>
    candidate.action === "remove" ? claimAndRemove(root, candidate, now, isPidLive) : candidate,
  );
}
