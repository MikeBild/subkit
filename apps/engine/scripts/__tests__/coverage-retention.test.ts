import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneExpiredCoverageRawRuns } from "../audit/coverage-retention.ts";

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "subkit-coverage-retention-"));
  roots.push(path);
  return path;
};
const lease = (coverage: string, runId: string, marker: Record<string, unknown>) => {
  const dir = join(coverage, "raw", "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "lease.json"),
    `${JSON.stringify({ version: 1, kind: "subkit-coverage-raw-run", run_id: runId, lease_token: "fixture", retained_at: "2019-12-01T00:00:00.000Z", ...marker })}\n`,
  );
  return dir;
};
afterEach(() => {
  roots.splice(0).forEach((path) => {
    rmSync(path, { recursive: true, force: true });
  });
});

describe("coverage raw retention", () => {
  test("a checkout without coverage reports needs no cleanup", () => {
    const coverage = join(root(), "reports", "coverage");
    expect(pruneExpiredCoverageRawRuns(coverage)).toEqual([]);
    expect(pruneExpiredCoverageRawRuns(coverage, { apply: true })).toEqual([]);
    expect(existsSync(coverage)).toBe(false);
  });

  test("a dangling coverage symlink remains unsafe", () => {
    const directory = root();
    const coverage = join(directory, "coverage");
    symlinkSync(join(directory, "missing"), coverage);
    expect(() => pruneExpiredCoverageRawRuns(coverage)).toThrow("unsafe coverage raw symlink");
    expect(() => pruneExpiredCoverageRawRuns(coverage, { apply: true })).toThrow(
      "unsafe coverage raw symlink",
    );
  });

  test("previews then explicitly removes only expired dead owned failed runs", () => {
    const coverage = root();
    const expired = lease(coverage, "expired-run-123", {
      state: "failed",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    lease(coverage, "legacy-run-123", { state: "failed" });
    lease(coverage, "active-run-123", {
      state: "failed",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: process.pid,
    });
    expect(
      pruneExpiredCoverageRawRuns(coverage, {
        now: new Date("2026-01-01"),
        isPidLive: (pid) => (pid === process.pid ? "live" : "dead"),
      }),
    ).toEqual([
      { runId: "active-run-123", action: "skip", reason: "lease owner is active" },
      { runId: "expired-run-123", action: "delete", reason: "expired finalized owned raw run" },
      { runId: "legacy-run-123", action: "skip", reason: "invalid retention marker" },
    ]);
    pruneExpiredCoverageRawRuns(coverage, {
      apply: true,
      now: new Date("2026-01-01"),
      isPidLive: (pid) => (pid === process.pid ? "live" : "dead"),
    });
    expect(() => readFileSync(join(expired, "lease.json"))).toThrow();
  });

  test("skips pinned, running, malformed and legacy raw directories", () => {
    const coverage = root();
    lease(coverage, "pinned-run-123", {
      state: "debug",
      pinned: true,
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    lease(coverage, "running-run-123", {
      state: "running",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    mkdirSync(join(coverage, "raw", "runs", "unknown"), { recursive: true });
    const actions = pruneExpiredCoverageRawRuns(coverage, {
      now: new Date("2026-01-01"),
      isPidLive: () => "dead",
    });
    expect(actions.map((item) => item.action)).toEqual(["skip", "skip", "skip"]);
  });

  test("rejects invalid clock and preserves invalid pid, short retention and symlinked markers", () => {
    const coverage = root();
    lease(coverage, "zero-pid-run", {
      state: "failed",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 0,
    });
    lease(coverage, "short-run-123", {
      state: "failed",
      retained_at: "2019-12-31T00:00:00.000Z",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    const linked = lease(coverage, "linked-run123", {
      state: "failed",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    rmSync(join(linked, "lease.json"));
    symlinkSync(join(coverage, "outside.json"), join(linked, "lease.json"));
    writeFileSync(join(coverage, "outside.json"), "{}");
    expect(() => pruneExpiredCoverageRawRuns(coverage, { now: new Date("invalid") })).toThrow(
      "valid current time",
    );
    const actions = pruneExpiredCoverageRawRuns(coverage, {
      now: new Date("2026-01-01"),
      isPidLive: () => "dead",
    });
    expect(actions.map((item) => item.reason)).toEqual([
      "unknown or unmarked raw run",
      "invalid retention marker",
      "unknown lease owner",
    ]);
  });

  test("rejects a symlink ancestor for the owned coverage root", () => {
    const base = root();
    mkdirSync(join(base, "target"));
    symlinkSync(join(base, "target"), join(base, "link"));
    expect(() => pruneExpiredCoverageRawRuns(join(base, "link"))).toThrow("symlink ancestor");
  });

  test("two independent pruners claim one expired raw run without double removal", async () => {
    const coverage = root();
    lease(coverage, "contended-run", {
      state: "failed",
      retention_until: "2020-01-01T00:00:00.000Z",
      owner_pid: 999999,
    });
    const module = new URL("../audit/coverage-retention.ts", import.meta.url).href;
    const source = `import {pruneExpiredCoverageRawRuns as p} from ${JSON.stringify(module)}; p(${JSON.stringify(coverage)},{apply:true,now:new Date('2026-01-01'),isPidLive:()=> 'dead'});`;
    const [a, b] = [Bun.spawn(["bun", "-e", source]), Bun.spawn(["bun", "-e", source])];
    expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
    expect(() =>
      readFileSync(join(coverage, "raw", "runs", "contended-run", "lease.json")),
    ).toThrow();
  });
});
