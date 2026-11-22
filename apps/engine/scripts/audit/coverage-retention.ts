import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CoveragePruneAction {
  runId: string;
  action: "delete" | "skip";
  reason: string;
}
export interface CoveragePruneOptions {
  apply?: boolean;
  now?: Date;
  isPidLive?: (pid: number) => "live" | "dead" | "unknown";
}
type Lease = Record<string, unknown>;

function noSymlink(path: string, boundary: string): void {
  const stop = resolve(boundary);
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`unsafe coverage raw symlink ancestor: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === stop) return;
  }
}
function live(pid: number): "live" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
function inspect(
  directory: string,
  runId: string,
  now: Date,
  pidLive: (pid: number) => "live" | "dead" | "unknown",
): CoveragePruneAction {
  let lease: Lease;
  try {
    noSymlink(directory, resolve(directory, "..", ".."));
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    const marker = join(directory, "lease.json");
    const markerStat = lstatSync(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error();
    lease = JSON.parse(readFileSync(marker, "utf8")) as Lease;
  } catch {
    return { runId, action: "skip", reason: "unknown or unmarked raw run" };
  }
  if (
    lease.version !== 1 ||
    lease.kind !== "subkit-coverage-raw-run" ||
    lease.run_id !== runId ||
    typeof lease.lease_token !== "string"
  )
    return { runId, action: "skip", reason: "invalid ownership marker" };
  if (lease.pinned === true) return { runId, action: "skip", reason: "pinned raw run" };
  if (lease.state !== "failed" && lease.state !== "debug")
    return { runId, action: "skip", reason: "non-finalized raw run" };
  const retained = typeof lease.retained_at === "string" ? Date.parse(lease.retained_at) : NaN;
  const expires =
    typeof lease.retention_until === "string" ? Date.parse(lease.retention_until) : NaN;
  if (!Number.isFinite(retained) || !Number.isFinite(expires) || expires < retained + 30 * 86400000)
    return { runId, action: "skip", reason: "invalid retention marker" };
  if (expires > now.getTime())
    return { runId, action: "skip", reason: "retention has not expired" };
  if (!Number.isInteger(lease.owner_pid) || (lease.owner_pid as number) <= 0)
    return { runId, action: "skip", reason: "unknown lease owner" };
  const state = pidLive(lease.owner_pid as number);
  return state === "dead"
    ? { runId, action: "delete", reason: "expired finalized owned raw run" }
    : {
        runId,
        action: "skip",
        reason: state === "live" ? "lease owner is active" : "lease owner is unknown",
      };
}
function claim(
  root: string,
  action: CoveragePruneAction,
  now: Date,
  pidLive: (pid: number) => "live" | "dead" | "unknown",
): CoveragePruneAction {
  const original = join(root, action.runId);
  const claimed = join(root, `.${action.runId}.pruning-${randomUUID()}`);
  try {
    renameSync(original, claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...action, action: "skip", reason: "changed before claim" };
    throw error;
  }
  try {
    const rechecked = inspect(claimed, action.runId, now, pidLive);
    if (rechecked.action !== "delete") {
      renameSync(claimed, original);
      return { ...action, action: "skip", reason: `changed after claim: ${rechecked.reason}` };
    }
    rmSync(claimed, { recursive: true, force: false, maxRetries: 1 });
    return action;
  } catch (error) {
    try {
      renameSync(claimed, original);
    } catch {}
    throw error;
  }
}
export function pruneExpiredCoverageRawRuns(
  coverageDir: string,
  options: CoveragePruneOptions = {},
): CoveragePruneAction[] {
  const inputCoverage = resolve(coverageDir);
  noSymlink(inputCoverage, inputCoverage);
  let canonicalCoverage: string;
  try {
    canonicalCoverage = realpathSync(inputCoverage);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const root = resolve(canonicalCoverage, "raw", "runs");
  try {
    noSymlink(root, canonicalCoverage);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`unsafe coverage raw root: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("pruning requires a valid current time");
  const pidLive = options.isPidLive ?? live;
  const actions = readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) =>
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^[a-z0-9][a-z0-9-]{0,119}$/.test(entry.name)
        ? { runId: entry.name, action: "skip" as const, reason: "not an owned raw run directory" }
        : inspect(join(root, entry.name), entry.name, now, pidLive),
    );
  return options.apply
    ? actions.map((action) =>
        action.action === "delete" ? claim(root, action, now, pidLive) : action,
      )
    : actions;
}

export function pruneSupersededCoverageRuns(
  coverageDir: string,
  options: { apply?: boolean } = {},
): CoveragePruneAction[] {
  const coverage = resolve(coverageDir);
  const runs = join(coverage, "runs");
  let latest: unknown;
  try {
    latest = (
      JSON.parse(readFileSync(join(coverage, "latest.json"), "utf8")) as { run_id?: unknown }
    ).run_id;
    noSymlink(runs, coverage);
    if (!lstatSync(runs).isDirectory()) return [];
  } catch {
    return [];
  }
  if (typeof latest !== "string") return [];
  const actions = readdirSync(runs, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry): CoveragePruneAction => {
      if (entry.name === latest)
        return { runId: entry.name, action: "skip", reason: "latest published run" };
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-z0-9-]{10,200}$/.test(entry.name))
        return { runId: entry.name, action: "skip", reason: "not a published run directory" };
      if (existsSync(join(coverage, "raw", "runs", entry.name)))
        return { runId: entry.name, action: "skip", reason: "raw run still leased" };
      return { runId: entry.name, action: "delete", reason: "superseded published run" };
    });
  if (!options.apply) return actions;
  for (const action of actions) {
    if (action.action !== "delete") continue;
    const claimed = join(runs, `.${action.runId}.pruning-${randomUUID()}`);
    renameSync(join(runs, action.runId), claimed);
    rmSync(claimed, { recursive: true, force: true, maxRetries: 1 });
  }
  return actions;
}
