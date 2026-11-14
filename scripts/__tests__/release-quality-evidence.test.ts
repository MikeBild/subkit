import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCoverageRunLease,
  createDirectTargetProof,
} from "../../apps/engine/scripts/audit/coverage-artifacts.ts";
import { publishCoverageReceipt } from "../../apps/engine/scripts/audit/coverage-publication.ts";
import {
  packageReleaseQualityEvidence,
  verifyReleaseQualityEvidence,
} from "../release-quality-evidence.ts";

const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "subkit-release-evidence-test-"));
  roots.push(root);
  return root;
}

async function publishCoverage(root: string): Promise<string> {
  const coverage = join(root, "reports", "coverage");
  const target = "packages/shared/src/example.ts";
  const lcov = `SF:${target}\nFN:1,f\nFNDA:1,f\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
  const proof = createDirectTargetProof(target, lcov);
  await publishCoverageReceipt({
    coverageDir: coverage,
    lease: createCoverageRunLease(coverage),
    lcov,
    provenance: {
      version: 4,
      scope: [target],
      direct_target_evidence: [{ target, path: proof.relativePath, sha256: proof.sha256 }],
    },
    directTargetProofs: [proof],
  });
  return coverage;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("packages only the selected global coverage run and fails closed", async () => {
  const root = fixtureRoot();
  writeFileSync(join(root, ".gitignore"), "reports/\nrelease-assets/\n");
  writeFileSync(join(root, "source.txt"), "fixture\n");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = git(root, ["rev-parse", "HEAD"]);
  const coverage = await publishCoverage(root);
  const assets = join(root, "release-assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "existing-binary"), "preserved");
  await expect(
    packageReleaseQualityEvidence({
      repo: root,
      commit: "b".repeat(40),
      qualityRunId: "43185845545",
      releaseRunId: "43185845546",
      coverageDir: coverage,
      assetsDir: assets,
    }),
  ).rejects.toThrow("release checkout does not match commit");
  const options = {
    repo: root,
    commit,
    qualityRunId: "43185845545",
    releaseRunId: "43185845546",
    coverageDir: coverage,
    assetsDir: assets,
  };
  await packageReleaseQualityEvidence(options);
  await expect(packageReleaseQualityEvidence(options)).rejects.toThrow("already exists");
  const verified = verifyReleaseQualityEvidence({ commit, assetsDir: assets });
  expect(verified.version).toBe(3);
  expect(verified.quality_github_run_id).toBe("43185845545");
  expect(verified.release_github_run_id).toBe("43185845546");
  expect(verified.payload.some((file) => file.path === "coverage/latest.json")).toBe(true);
  expect(verified.payload.every((file) => file.path.startsWith("coverage/"))).toBe(true);
  expect(readFileSync(join(assets, "existing-binary"), "utf8")).toBe("preserved");
  const index = JSON.parse(readFileSync(join(assets, "quality-evidence.json"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(join(assets, "quality-evidence.json"), JSON.stringify({ ...index, version: 2 }));
  expect(() => verifyReleaseQualityEvidence({ commit, assetsDir: assets })).toThrow(
    "malformed or belongs to another commit",
  );
  writeFileSync(
    join(assets, "quality-evidence.json"),
    JSON.stringify({ ...index, coverage_receipt_sha256: "0".repeat(64) }),
  );
  expect(() => verifyReleaseQualityEvidence({ commit, assetsDir: assets })).toThrow(
    "coverage binding changed",
  );
  writeFileSync(join(assets, "quality-evidence.json"), JSON.stringify(index));
  expect(verifyReleaseQualityEvidence({ commit, assetsDir: assets }).version).toBe(3);
  writeFileSync(join(assets, "quality-evidence.tar.gz"), "tampered");
  expect(() => verifyReleaseQualityEvidence({ commit, assetsDir: assets })).toThrow(
    "archive changed",
  );
});

test("rejects foreign commits and unsafe archive payload names", () => {
  const root = fixtureRoot();
  const assets = join(root, "release-assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "quality-evidence.tar.gz"), "not-a-tar");
  writeFileSync(
    join(assets, "quality-evidence.json"),
    JSON.stringify({
      version: 3,
      commit_sha: "a".repeat(40),
      quality_github_run_id: "1",
      release_github_run_id: "2",
      coverage_run_id: "coverage-run",
      coverage_receipt_sha256: "c".repeat(64),
      archive: { path: "quality-evidence.tar.gz", sha256: hash("not-a-tar") },
      payload: [{ path: "../escape", sha256: "b".repeat(64) }],
    }),
  );
  expect(() => verifyReleaseQualityEvidence({ commit: "a".repeat(40), assetsDir: assets })).toThrow(
    "payload is malformed",
  );
  expect(() => verifyReleaseQualityEvidence({ commit: "b".repeat(40), assetsDir: assets })).toThrow(
    "belongs to another commit",
  );
});

test("rejects link members before extraction", () => {
  const root = fixtureRoot();
  const assets = join(root, "release-assets");
  const payload = join(root, "malicious-payload");
  const outside = join(root, "outside");
  mkdirSync(join(payload, "coverage"), { recursive: true });
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, join(payload, "coverage", "latest.json"));
  mkdirSync(assets);
  execFileSync("tar", ["-C", payload, "-czf", join(assets, "quality-evidence.tar.gz"), "."]);
  const archive = readFileSync(join(assets, "quality-evidence.tar.gz"));
  writeFileSync(
    join(assets, "quality-evidence.json"),
    JSON.stringify({
      version: 3,
      commit_sha: "a".repeat(40),
      quality_github_run_id: "1",
      release_github_run_id: "2",
      coverage_run_id: "coverage-run",
      coverage_receipt_sha256: "c".repeat(64),
      archive: { path: "quality-evidence.tar.gz", sha256: hash(archive) },
      payload: [{ path: "coverage/latest.json", sha256: "e".repeat(64) }],
    }),
  );
  expect(() => verifyReleaseQualityEvidence({ commit: "a".repeat(40), assetsDir: assets })).toThrow(
    "unsafe member type",
  );
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
});
