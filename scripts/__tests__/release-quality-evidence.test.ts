import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { exportShardQualityEvidence } from "../export-shard-quality-evidence.ts";
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

function bindParentTicket(source: ReturnType<typeof qualityChainFixture>): void {
  const manifestPath = join(source.root, source.mutationRoot, "wave.json");
  const text = readFileSync(manifestPath, "utf8");
  const ticket = writeMutationValidationTicket({
    repo: source.root,
    parentRunRoot: join(source.root, source.mutationRoot),
    copiedManifestPath: manifestPath,
    manifestText: text,
    wave: source.wave,
    entries: assertCompletePureTargetInventory(source.targets),
    runId: "run-mutation",
    runtimeInputs: mutationTestInputs(source.root),
    closureFiles: mutationClosureFiles(source.root),
  });
  for (const shard of source.wave.shards) {
    const path = join(source.root, source.mutationRoot, shard.id, "receipt.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    receipt.parent_validation_ticket_path = `${source.mutationRoot}/mutation-validation-ticket.json`;
    receipt.parent_validation_ticket_sha256 = ticket.sha256;
    writeFileSync(path, JSON.stringify(receipt));
  }
  const path = join(source.root, source.mutationRoot, "union.json");
  const union = JSON.parse(readFileSync(path, "utf8")) as {
    shards: Array<{ id: string; receipt_sha256: string }>;
  };
  for (const shard of union.shards)
    shard.receipt_sha256 = hash(
      readFileSync(join(source.root, source.mutationRoot, shard.id, "receipt.json"), "utf8"),
    );
  writeFileSync(path, JSON.stringify(union));
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

test("packages a verified shard closure plus only the selected global coverage run and fails closed", async () => {
  const source = qualityChainFixture(true, true, false, true);
  roots.push(source.root);
  bindParentTicket(source);
  writeFileSync(join(source.root, ".gitignore"), "reports/\n.artifacts/\nassets/\n");
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
  const temporaryBundle = join(source.root, ".artifacts", "bundle");
  const bundle = await exportShardQualityEvidence({
    ...source.options,
    externalRuntimeAcceptancePath: external,
    destination: temporaryBundle,
  });
  const index = "reports/quality-export/shards/quality-bundle.json";
  mkdirSync(join(source.root, "reports/quality-export/shards"), { recursive: true });
  cpSync(bundle, join(source.root, index));
  const coverage = await publishCoverage(source.root);
  const assets = join(source.root, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "existing-binary"), "preserved");
  await packageReleaseQualityEvidence({
    repo: source.root,
    commit,
    qualityRunId: "43185845545",
    releaseRunId: "43185845546",
    coverageDir: coverage,
    shardIndex: index,
    assetsDir: assets,
  });
  const verified = verifyReleaseQualityEvidence({ commit, assetsDir: assets });
  expect(verified.quality_github_run_id).toBe("43185845545");
  expect(verified.release_github_run_id).toBe("43185845546");
  expect(verified.payload.some((file) => file.path === "coverage/latest.json")).toBe(true);
  expect(verified.payload.some((file) => file.path === "shards/quality-bundle.json")).toBe(true);
  expect(readFileSync(join(assets, "existing-binary"), "utf8")).toBe("preserved");
  const v2 = JSON.parse(readFileSync(join(assets, "quality-evidence.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const { quality_github_run_id, release_github_run_id, ...legacy } = v2;
  writeFileSync(
    join(assets, "quality-evidence.json"),
    `${JSON.stringify({ ...legacy, version: 1, github_run_id: quality_github_run_id })}\n`,
  );
  expect(verifyReleaseQualityEvidence({ commit, assetsDir: assets }).version).toBe(1);
  expect(
    JSON.parse(readFileSync(join(assets, "quality-evidence.json"), "utf8")),
  ).not.toHaveProperty("release_github_run_id");
  writeFileSync(join(assets, "quality-evidence.tar.gz"), "tampered");
  expect(() => verifyReleaseQualityEvidence({ commit, assetsDir: assets })).toThrow(
    "archive changed",
  );
});

test("rejects foreign commits and unsafe archive payload names", () => {
  const root = qualityChainFixture().root;
  roots.push(root);
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "quality-evidence.tar.gz"), "not-a-tar");
  writeFileSync(
    join(assets, "quality-evidence.json"),
    JSON.stringify({
      version: 2,
      commit_sha: "a".repeat(40),
      quality_github_run_id: "1",
      release_github_run_id: "2",
      coverage_run_id: "coverage-run",
      coverage_receipt_sha256: "c".repeat(64),
      shard_bundle_sha256: "d".repeat(64),
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
  const root = qualityChainFixture().root;
  roots.push(root);
  const assets = join(root, "assets");
  const payload = join(root, "malicious-payload");
  const outside = join(root, "outside");
  mkdirSync(join(payload, "coverage"), { recursive: true });
  mkdirSync(join(payload, "shards"), { recursive: true });
  writeFileSync(outside, "unchanged");
  symlinkSync(outside, join(payload, "coverage", "latest.json"));
  writeFileSync(join(payload, "shards", "quality-bundle.json"), "{}");
  mkdirSync(assets);
  execFileSync("tar", ["-C", payload, "-czf", join(assets, "quality-evidence.tar.gz"), "."]);
  const archive = readFileSync(join(assets, "quality-evidence.tar.gz"));
  writeFileSync(
    join(assets, "quality-evidence.json"),
    JSON.stringify({
      version: 2,
      commit_sha: "a".repeat(40),
      quality_github_run_id: "1",
      release_github_run_id: "2",
      coverage_run_id: "coverage-run",
      coverage_receipt_sha256: "c".repeat(64),
      shard_bundle_sha256: "d".repeat(64),
      archive: { path: "quality-evidence.tar.gz", sha256: hash(archive) },
      payload: [
        { path: "coverage/latest.json", sha256: "e".repeat(64) },
        { path: "shards/quality-bundle.json", sha256: "f".repeat(64) },
      ],
    }),
  );
  expect(() => verifyReleaseQualityEvidence({ commit: "a".repeat(40), assetsDir: assets })).toThrow(
    "unsafe member type",
  );
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
});
