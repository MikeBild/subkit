import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVerificationRun,
  finalizeVerificationRun,
  pruneVerificationRuns,
  verificationRunsRoot,
} from "./verification-run-lifecycle.ts";

const roots: string[] = [];

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "subkit-verification-runs-")));
  roots.push(value);
  return join(value, "runs");
}

function complete(
  root: string,
  runId: string,
  retention: "regular" | "failure" | "debug" | "release" | "pinned" | "historical" = "regular",
) {
  return finalizeVerificationRun(createVerificationRun({ root, runId, owner: "test", retention }), {
    status: "passed",
    resultPath: "result.json",
    retention,
  });
}

function expire(directory: string): void {
  const file = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    startedAt: string;
    finishedAt: string;
    retention: { class: "regular" | "failure" | "debug"; expiresAt: string | null };
  };
  manifest.startedAt = "1999-12-31T00:00:00.000Z";
  manifest.finishedAt = "2000-01-01T00:00:00.000Z";
  const days = manifest.retention.class === "regular" ? 90 : 30;
  manifest.retention.expiresAt = new Date(
    new Date(manifest.finishedAt).getTime() + days * 24 * 60 * 60 * 1000,
  ).toISOString();
  writeFileSync(file, `${JSON.stringify(manifest)}\n`);
}

function leasePid(directory: string, pid: number): void {
  const file = join(directory, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { lease: { pid: number } };
  manifest.lease.pid = pid;
  writeFileSync(file, `${JSON.stringify(manifest)}\n`);
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("creates a marked run with a lease and finalizes regular evidence for 90 days", () => {
  const run = createVerificationRun({
    root: root(),
    runId: "campaign-1",
    owner: "campaign",
    logPath: "runner.log",
  });
  expect(run.manifest.status).toBe("running");
  expect(run.manifest.lease.pid).toBe(process.pid);
  const finalized = finalizeVerificationRun(run, { status: "passed", resultPath: "result.json" });
  expect(finalized.manifest.retention.class).toBe("regular");
  expect(
    new Date(finalized.manifest.retention.expiresAt!).getTime() -
      new Date(finalized.manifest.finishedAt!).getTime(),
  ).toBe(90 * 24 * 60 * 60 * 1000);
});

test("applies the 30-day policy to failure and debug evidence", () => {
  for (const retention of ["failure", "debug"] as const) {
    const finalized = complete(root(), `${retention}-run`, retention);
    expect(
      new Date(finalized.manifest.retention.expiresAt!).getTime() -
        new Date(finalized.manifest.finishedAt!).getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000);
  }
});

test("previews an expired owned run and removes it only with explicit apply", () => {
  const runs = root();
  const finalized = complete(runs, "expired-run");
  expire(finalized.directory);
  const preview = pruneVerificationRuns(runs, { isPidLive: () => "dead" });
  expect(preview).toEqual([
    expect.objectContaining({
      runId: "expired-run",
      action: "remove",
      reason: "completed_expired_unleased",
    }),
  ]);
  expect(Bun.file(join(finalized.directory, "manifest.json")).size).toBeGreaterThan(0);
  pruneVerificationRuns(runs, { apply: true, isPidLive: () => "dead" });
  expect(Bun.file(join(finalized.directory, "manifest.json")).size).toBe(0);
});

test("keeps live and unknown leases even after a completed run expires", () => {
  const runs = root();
  const live = complete(runs, "live-run");
  const unknown = complete(runs, "unknown-run");
  expire(live.directory);
  expire(unknown.directory);
  leasePid(unknown.directory, process.pid + 10_000);
  expect(
    pruneVerificationRuns(runs, {
      apply: true,
      isPidLive: (pid) => (pid === process.pid ? "live" : "unknown"),
    }),
  ).toEqual([
    expect.objectContaining({ runId: "live-run", action: "skip", reason: "live_lease" }),
    expect.objectContaining({ runId: "unknown-run", action: "skip", reason: "unknown_lease" }),
  ]);
  expect(Bun.file(join(live.directory, "manifest.json")).size).toBeGreaterThan(0);
  expect(Bun.file(join(unknown.directory, "manifest.json")).size).toBeGreaterThan(0);
});

test("two real pruner processes claim an expired run without double deletion", async () => {
  const runs = root();
  const finalized = complete(runs, "contended-run");
  expire(finalized.directory);
  const module = new URL("./verification-run-lifecycle.ts", import.meta.url).href;
  const source = `import { pruneVerificationRuns } from ${JSON.stringify(module)}; pruneVerificationRuns(${JSON.stringify(runs)}, { apply: true, isPidLive: () => "dead" });`;
  const first = Bun.spawn(["bun", "-e", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const second = Bun.spawn(["bun", "-e", source], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exits = await Promise.all([first.exited, second.exited]);
  expect(exits).toEqual([0, 0]);
  expect(Bun.file(join(finalized.directory, "manifest.json")).size).toBe(0);
});

test("preserves release, pinned, historical, legacy, malformed, and running directories", () => {
  const runs = root();
  for (const retention of ["release", "pinned", "historical"] as const)
    complete(runs, `${retention}-run`, retention);
  const running = createVerificationRun({ root: runs, runId: "running-run", owner: "test" });
  const legacy = join(runs, "legacy-run");
  const malformed = join(runs, "malformed-run");
  mkdirSync(legacy, { recursive: true });
  mkdirSync(malformed, { recursive: true });
  writeFileSync(join(malformed, "manifest.json"), "{}\n");
  const result = pruneVerificationRuns(runs, { apply: true, isPidLive: () => "dead" });
  expect(result.map((item) => [item.runId, item.reason])).toEqual([
    ["historical-run", "retention_preserved"],
    ["legacy-run", "unrecognized_or_unsafe_manifest"],
    ["malformed-run", "unrecognized_or_unsafe_manifest"],
    ["pinned-run", "retention_preserved"],
    ["release-run", "retention_preserved"],
    ["running-run", "run_not_completed"],
  ]);
  expect(Bun.file(join(running.directory, "manifest.json")).size).toBeGreaterThan(0);
});

test("refuses path traversal and does not make a release path a pruning root", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "subkit-verification-root-")));
  roots.push(base);
  expect(() =>
    createVerificationRun({ root: join(base, "runs"), runId: "../release", owner: "test" }),
  ).toThrow("run id");
  expect(verificationRunsRoot(base)).toBe(join(base, ".artifacts", "goal-verification", "runs"));
});

test("refuses a caller-controlled symlink anywhere in the run-root chain", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "subkit-verification-symlink-")));
  roots.push(base);
  mkdirSync(join(base, "target"));
  symlinkSync(join(base, "target"), join(base, "link"));
  expect(() => createVerificationRun({ root: join(base, "link", "runs"), owner: "test" })).toThrow(
    "symlink ancestor",
  );
});
