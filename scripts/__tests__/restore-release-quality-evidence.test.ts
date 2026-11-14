import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityChainFixture } from "../../apps/engine/scripts/__tests__/fixtures/quality-chain.ts";
import {
  createCoverageRunLease,
  createDirectTargetProof,
} from "../../apps/engine/scripts/audit/coverage-artifacts.ts";
import { publishCoverageReceipt } from "../../apps/engine/scripts/audit/coverage-publication.ts";
import {
  mutationClosureFiles,
  mutationTestInputs,
} from "../../apps/engine/scripts/audit/mutation-inputs.ts";
import { writeMutationValidationTicket } from "../../apps/engine/scripts/audit/mutation-validation-ticket.ts";
import { assertCompletePureTargetInventory } from "../../apps/engine/scripts/audit/pure-targets.ts";
import { exportCoverageEvidence } from "../export-quality-evidence.ts";
import { exportShardQualityEvidence } from "../export-shard-quality-evidence.ts";
import {
  packageReleaseQualityEvidence,
  verifyReleaseQualityEvidence,
} from "../release-quality-evidence.ts";
import { restoreReleaseQualityEvidence } from "../restore-release-quality-evidence.ts";
import { verifyShardQualityBundle } from "../verify-shard-quality-bundle.ts";

const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function bindParentTicket(source: ReturnType<typeof qualityChainFixture>): void {
  const manifest = join(source.root, source.mutationRoot, "wave.json");
  const text = readFileSync(manifest, "utf8");
  const ticket = writeMutationValidationTicket({
    repo: source.root,
    parentRunRoot: join(source.root, source.mutationRoot),
    copiedManifestPath: manifest,
    manifestText: text,
    wave: source.wave,
    entries: assertCompletePureTargetInventory(source.targets),
    runId: "run-mutation",
    runtimeInputs: mutationTestInputs(source.root),
    closureFiles: mutationClosureFiles(source.root),
    runtimeSnapshot: { ...source.runtimeSnapshot, sealSha256: source.runtimeSnapshotSeal },
  });
  for (const shard of source.wave.shards) {
    const path = join(source.root, source.mutationRoot, shard.id, "receipt.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    receipt.parent_validation_ticket_path = `${source.mutationRoot}/mutation-validation-ticket.json`;
    receipt.parent_validation_ticket_sha256 = ticket.sha256;
    writeFileSync(path, JSON.stringify(receipt));
  }
  const unionPath = join(source.root, source.mutationRoot, "union.json");
  const union = JSON.parse(readFileSync(unionPath, "utf8")) as {
    shards: Array<{ id: string; receipt_sha256: string }>;
  };
  for (const shard of union.shards)
    shard.receipt_sha256 = hash(
      readFileSync(join(source.root, source.mutationRoot, shard.id, "receipt.json"), "utf8"),
    );
  writeFileSync(unionPath, JSON.stringify(union));
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

test("restores the verified closure at repo-relative paths and downstream verification succeeds", async () => {
  const source = qualityChainFixture(true, true, false, true);
  const transfer = realpathSync(mkdtempSync(join(tmpdir(), "subkit-restore-transfer-")));
  roots.push(source.root, transfer);
  bindParentTicket(source);
  writeFileSync(join(source.root, ".gitignore"), "reports/\n.artifacts/\n");
  git(source.root, ["init", "--quiet"]);
  git(source.root, ["add", "."]);
  git(source.root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const commit = git(source.root, ["rev-parse", "HEAD"]);
  const external = source.createExternalRuntimeAcceptance();
  await exportShardQualityEvidence({
    ...source.options,
    externalRuntimeAcceptancePath: external,
    destination: join(transfer, "bundle"),
  });
  const checkout = join(transfer, "checkout");
  git(transfer, ["clone", "--quiet", "--no-hardlinks", source.root, checkout]);
  const index = restoreReleaseQualityEvidence({
    repo: checkout,
    source: join(transfer, "bundle"),
    commit,
  });
  expect(index).toBe("reports/quality-export/shards/quality-bundle.json");
  expect(existsSync(join(checkout, index))).toBe(true);
  expect(await verifyShardQualityBundle(checkout, commit, index)).toContain("acceptance");
  const sourceCoverage = await publishCoverage(source.root);
  const coverageDownload = join(transfer, "coverage-download");
  exportCoverageEvidence(sourceCoverage, coverageDownload);
  mkdirSync(join(checkout, "reports"), { recursive: true });
  cpSync(coverageDownload, join(checkout, "reports", "coverage"), { recursive: true });
  const assets = join(checkout, "release-assets");
  await packageReleaseQualityEvidence({
    repo: checkout,
    commit,
    qualityRunId: "43185845545",
    releaseRunId: "43185845546",
    coverageDir: "reports/coverage",
    assetsDir: assets,
  });
  expect(verifyReleaseQualityEvidence({ commit, assetsDir: assets }).coverage_run_id).toBeTruthy();
  expect(
    restoreReleaseQualityEvidence({ repo: checkout, source: join(transfer, "bundle"), commit }),
  ).toBe(index);
});

test("rejects tampered source bytes, foreign commits, and destination conflicts before writes", async () => {
  const root = qualityChainFixture().root;
  const source = join(root, "source");
  roots.push(root);
  const commit = "a".repeat(40);
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
  const actual = git(root, ["rev-parse", "HEAD"]);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "proof.json"), "original");
  writeFileSync(
    join(source, "quality-bundle.json"),
    JSON.stringify({
      version: 1,
      commit_sha: commit,
      acceptance_path: "proof.json",
      mutation_union_path: "proof.json",
      coverage_union_path: "proof.json",
      files: [{ path: "proof.json", sha256: hash("original") }],
    }),
  );
  expect(() => restoreReleaseQualityEvidence({ repo: root, source, commit })).toThrow(
    "does not match",
  );
  const sourceIndex = JSON.parse(readFileSync(join(source, "quality-bundle.json"), "utf8"));
  sourceIndex.commit_sha = actual;
  writeFileSync(join(source, "quality-bundle.json"), JSON.stringify(sourceIndex));
  writeFileSync(join(root, "proof.json"), "conflict");
  expect(() => restoreReleaseQualityEvidence({ repo: root, source, commit: actual })).toThrow(
    "conflicts",
  );
  expect(readFileSync(join(root, "proof.json"), "utf8")).toBe("conflict");
  writeFileSync(join(root, "proof.json"), "original");
  writeFileSync(join(source, "proof.json"), "tampered");
  expect(() => restoreReleaseQualityEvidence({ repo: root, source, commit: actual })).toThrow(
    "bundle file changed",
  );
});

test("rejects a late non-directory destination before writing an earlier closure file", () => {
  const root = qualityChainFixture().root;
  const source = join(root, "source");
  roots.push(root);
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
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "first.json"), "first");
  mkdirSync(join(source, "blocked"));
  writeFileSync(join(source, "blocked", "second.json"), "second");
  writeFileSync(join(root, "blocked"), "not a directory");
  writeFileSync(
    join(source, "quality-bundle.json"),
    JSON.stringify({
      version: 1,
      commit_sha: commit,
      acceptance_path: "first.json",
      mutation_union_path: "first.json",
      coverage_union_path: "first.json",
      files: [
        { path: "first.json", sha256: hash("first") },
        { path: "blocked/second.json", sha256: hash("second") },
      ],
    }),
  );
  expect(() => restoreReleaseQualityEvidence({ repo: root, source, commit })).toThrow(
    "non-directory ancestor",
  );
  expect(existsSync(join(root, "first.json"))).toBe(false);
});
