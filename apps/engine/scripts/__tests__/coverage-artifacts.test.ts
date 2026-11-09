import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPreviousLcov,
  createCoverageRunLease,
  createDirectTargetProof,
  inputsChanged,
  prepareRawLcov,
  publishCoverageReceipt,
  readPublishedCoverage,
  removeCoverageRawRunAfterReceipt,
  retainCoverageRawRun,
  snapshotInputs,
} from "../audit/coverage-artifacts.ts";

const roots: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `subkit-coverage-artifacts-${name}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sampleLcov = (file = "apps/engine/src/example.ts") =>
  `TN:\nSF:${file}\nFN:1,one\nFNDA:1,one\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;

async function publish(coverageDir: string, target = "apps/engine/src/example.ts") {
  const lease = createCoverageRunLease(coverageDir, new Date("2026-01-02T03:04:05.000Z"));
  const rawLcov = prepareRawLcov(lease);
  writeFileSync(rawLcov, sampleLcov(target));
  const proof = createDirectTargetProof(target, sampleLcov(target));
  const published = await publishCoverageReceipt({
    coverageDir,
    lease,
    lcov: sampleLcov(target),
    provenance: {
      version: 4,
      direct_target_evidence: [{ target, path: proof.relativePath, sha256: proof.sha256 }],
    },
    directTargetProofs: [proof],
  });
  return { lease, published };
}

async function runPublicationChild(
  coverageDir: string,
  target: string,
  mode: "publish" | "signal",
) {
  const child = Bun.spawn(
    [
      "bun",
      "apps/engine/scripts/__tests__/fixtures/coverage-publication-child.ts",
      coverageDir,
      target,
      mode,
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("coverage artifacts", () => {
  test("removes a prior LCOV report before a coverage child runs", () => {
    const dir = tempDir("stale-lcov");
    const report = join(dir, "lcov.info");
    writeFileSync(report, "TN:stale\n");
    expect(clearPreviousLcov(dir)).toBe(report);
    expect(existsSync(report)).toBe(false);
  });

  test("detects changed and added coverage inputs", () => {
    const repo = tempDir("snapshot");
    writeFileSync(join(repo, "one.ts"), "export const one = 1;\n");
    const before = snapshotInputs(repo, ["one.ts"]);
    writeFileSync(join(repo, "one.ts"), "export const one = 2;\n");
    expect(inputsChanged(before, snapshotInputs(repo, ["one.ts"]))).toBe(true);
    writeFileSync(join(repo, "two.ts"), "export const two = 2;\n");
    expect(inputsChanged(before, snapshotInputs(repo, ["one.ts", "two.ts"]))).toBe(true);
  });

  test("keeps independent target proof while removing only a successful run raw root", async () => {
    const coverageDir = tempDir("success");
    const legacyRaw = join(coverageDir, "raw", "legacy-digest");
    mkdirSync(legacyRaw, { recursive: true });
    writeFileSync(join(legacyRaw, "lcov.info"), "legacy\n");
    const { lease, published } = await publish(coverageDir);
    removeCoverageRawRunAfterReceipt(lease);
    expect(existsSync(lease.rawDir)).toBe(false);
    expect(existsSync(legacyRaw)).toBe(true);
    const verified = readPublishedCoverage(coverageDir);
    expect(verified.runId).toBe(lease.runId);
    expect(readFileSync(verified.targetProofPaths[0], "utf8")).toBe(sampleLcov());
    expect(verified.latestContents).toContain(lease.runId);
    expect(verified.runDir).toBe(published.runDir);
  });

  test("retains failed and debug raw runs with a bounded lease marker", () => {
    const coverageDir = tempDir("retained");
    const lease = createCoverageRunLease(coverageDir, new Date("2026-01-02T03:04:05.000Z"));
    retainCoverageRawRun(lease, "failed", "fixture failure", new Date("2026-01-02T03:04:05.000Z"));
    const marker = JSON.parse(readFileSync(lease.leasePath, "utf8"));
    expect(marker.state).toBe("failed");
    expect(marker.retention_until).toBe("2026-02-01T03:04:05.000Z");
    expect(existsSync(lease.rawDir)).toBe(true);
  });

  test("prevents a forged lease from deleting a sibling concurrent raw run", async () => {
    const coverageDir = tempDir("siblings");
    const first = await publish(coverageDir, "apps/engine/src/first.ts");
    const sibling = createCoverageRunLease(coverageDir, new Date("2026-01-02T03:04:06.000Z"));
    const forged = { ...first.lease, rawDir: sibling.rawDir, leasePath: sibling.leasePath };
    expect(() => removeCoverageRawRunAfterReceipt(forged)).toThrow("outside owned runs root");
    expect(existsSync(sibling.rawDir)).toBe(true);
    removeCoverageRawRunAfterReceipt(first.lease);
  });

  test("refuses raw cleanup when its immutable receipt has changed", async () => {
    const coverageDir = tempDir("changed-receipt");
    const { lease, published } = await publish(coverageDir);
    writeFileSync(published.receiptPath, "changed");
    expect(() => removeCoverageRawRunAfterReceipt(lease)).toThrow();
    expect(existsSync(lease.rawDir)).toBe(true);
  });

  test("atomically switches a latest pointer between complete immutable receipts", async () => {
    const coverageDir = tempDir("pointer");
    const first = await publish(coverageDir, "apps/engine/src/first.ts");
    const before = readPublishedCoverage(coverageDir);
    const second = await publish(coverageDir, "apps/engine/src/second.ts");
    const after = readPublishedCoverage(coverageDir);
    expect(before.runId).toBe(first.lease.runId);
    expect(after.runId).toBe(second.lease.runId);
    expect(after.lcovPath).toContain(second.lease.runId);
    expect(after.provenancePath).toContain(second.lease.runId);
    expect(after.targetProofPaths[0]).toContain(second.lease.runId);
  });

  test("concurrent publishers keep separate raw leases and leave one complete selected receipt", async () => {
    const coverageDir = tempDir("concurrent");
    const [first, second] = await Promise.all([
      publish(coverageDir, "apps/engine/src/first.ts"),
      publish(coverageDir, "apps/engine/src/second.ts"),
    ]);
    const selected = readPublishedCoverage(coverageDir);
    expect(first.lease.rawDir).not.toBe(second.lease.rawDir);
    expect([first.lease.runId, second.lease.runId]).toContain(selected.runId);
    expect(first.published.runId).toBe(first.lease.runId);
    expect(second.published.runId).toBe(second.lease.runId);
    expect(first.published.receiptPath).toContain(first.lease.runId);
    expect(second.published.receiptPath).toContain(second.lease.runId);
    expect(existsSync(first.published.receiptPath)).toBe(true);
    expect(existsSync(second.published.receiptPath)).toBe(true);
    removeCoverageRawRunAfterReceipt(first.lease);
    removeCoverageRawRunAfterReceipt(second.lease);
  });

  test("independent processes serialize publication through the filesystem lock", async () => {
    const coverageDir = tempDir("child-concurrent");
    const outcomes = await Promise.all([
      runPublicationChild(coverageDir, "apps/engine/src/first.ts", "publish"),
      runPublicationChild(coverageDir, "apps/engine/src/second.ts", "publish"),
    ]);
    expect(outcomes.map((outcome) => outcome.exitCode)).toEqual([0, 0]);
    const selected = readPublishedCoverage(coverageDir);
    expect(selected.targetProofPaths).toHaveLength(1);
    expect(readFileSync(selected.targetProofPaths[0]!, "utf8")).toMatch(/first|second/);
  });

  test("a signalled child retains a marked raw lease for thirty days", async () => {
    const coverageDir = tempDir("child-signal");
    const outcome = await runPublicationChild(
      coverageDir,
      "apps/engine/src/interrupted.ts",
      "signal",
    );
    expect(outcome.exitCode).toBe(143);
    const runs = readdirSync(join(coverageDir, "raw", "runs"));
    expect(runs).toHaveLength(1);
    const marker = JSON.parse(
      readFileSync(join(coverageDir, "raw", "runs", runs[0]!, "lease.json"), "utf8"),
    );
    expect(marker.state).toBe("failed");
    expect(marker.reason).toBe("coverage process interrupted by SIGTERM");
    expect(marker.retention_until).toBeString();
  });
});
