import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { exportShardQualityEvidence } from "../../../../scripts/export-shard-quality-evidence.ts";
import {
  parseQualityBundleIndex,
  validatePortableParentValidationTicket,
  verifyShardQualityBundle,
} from "../../../../scripts/verify-shard-quality-bundle.ts";
import {
  packQualityArtifacts,
  restoreQualityArtifacts,
} from "../audit/distributed-quality-artifacts.ts";
import {
  canonicalDistributedQualityTicket,
  type DistributedQualityTicketV2,
  distributedQualityTicketSha256,
} from "../audit/distributed-quality-ticket.ts";
import { buildMutationShardConfig } from "../audit/mutation-shard-config.ts";
import { distributedShardPackageFiles } from "../distributed-quality.ts";
import { collectCoverageShardUnion } from "../run-coverage-shards.ts";
import {
  collectMutationShardUnion,
  prepareMutationShardExecution,
  publishMutationShardUnion,
} from "../run-mutation-shards.ts";
import { verifyQualityShards } from "../verify-quality-shards.ts";
import { qualityChainFixture } from "./fixtures/quality-chain.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function files(root: string, base = root): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path, base);
    return entry.isFile() ? [relative(base, path)] : [];
  });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGit(root: string): string {
  writeFileSync(join(root, ".gitignore"), "reports/\n.artifacts/\n.stryker-tmp/\n");
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Quality Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]);
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, filter: (path) => !path.includes("/.git/") });
}

test("two independent hosts produce a portable distributed quality bundle", async () => {
  const source = qualityChainFixture(true);
  const temporary = mkdtempSync(join(tmpdir(), "distributed-quality-protocol-"));
  const hostA = join(temporary, "host-a");
  const hostB = join(temporary, "host-b");
  let collector = join(temporary, "collector");
  try {
    const commit = initGit(source.root);
    const manifestText = readFileSync(join(source.root, source.mutationRoot, "wave.json"), "utf8");
    const ticket: DistributedQualityTicketV2 = {
      version: 2,
      coordinator_commit_sha: commit,
      github_run_id: "101",
      coverage_run_id: "run-coverage",
      mutation_run_id: "run-mutation",
      manifest_path: "reports/quality-inputs/distributed/wave.json",
      ticket_path: "reports/quality-inputs/distributed/ticket.json",
      wave_id: source.wave.wave_id,
      manifest_sha256: hash(manifestText),
      source_sha256: source.wave.source_freeze_sha256,
      test_sha256: source.wave.test_freeze_sha256,
      config_sha256: source.wave.config_sha256,
      lock_sha256: source.wave.lock_sha256,
      target_digest_sha256: source.wave.target_digest_sha256,
      quality_policy_sha256: source.wave.quality_policy_sha256!,
      dynamic_import_ledger_sha256: source.wave.dynamic_import_ledger_sha256,
      equivalence_manifest_sha256: source.wave.equivalence_manifest_sha256,
      runtime_snapshot: {
        path: relative(source.root, source.runtimeSnapshot.path),
        sha256: source.runtimeSnapshot.sha256,
        artifact_digest_sha256: source.runtimeSnapshot.snapshot.artifact_digest_sha256,
        artifacts: source.runtimeSnapshot.snapshot.artifacts.map((artifact) => ({ ...artifact })),
      },
      campaign_timeout_ms: 600_000,
      shards: source.wave.shards.map((shard) => ({
        id: shard.id,
        targets_sha256: hash(`${shard.targets.slice().sort().join("\n")}\n`),
        baseline_budget_ms: 60_000,
      })),
    };
    const ticketText = canonicalDistributedQualityTicket(ticket);
    const ticketSha256 = distributedQualityTicketSha256(ticket);
    const coordinatorPackage = join(temporary, "coordinator-package");
    packQualityArtifacts({
      repo: source.root,
      destination: coordinatorPackage,
      files: [
        relative(source.root, join(source.runtimeSnapshot.path, "runtime-snapshot.json")),
        ...source.runtimeSnapshot.snapshot.artifacts.map((artifact) =>
          relative(source.root, join(source.runtimeSnapshot.path, artifact.path)),
        ),
      ].sort(),
      identity: { commit, githubRunId: ticket.github_run_id, ticketSha256 },
    });
    for (const host of [hostA, hostB]) copyTree(source.root, host);
    for (const host of [hostA, hostB]) {
      const mutationWave = join(host, source.mutationRoot, "wave.json");
      for (const shard of source.wave.shards) {
        const coverageReceiptPath = join(host, source.coverageRoot, shard.id, "receipt.json");
        const coverageReceipt = JSON.parse(readFileSync(coverageReceiptPath, "utf8")) as Record<
          string,
          unknown
        >;
        Object.assign(coverageReceipt, {
          distributed_ticket_sha256: ticketSha256,
          coordinator_commit_sha: commit,
          github_run_id: ticket.github_run_id,
          lock_sha256: ticket.lock_sha256,
        });
        writeFileSync(coverageReceiptPath, json(coverageReceipt));
        const directory = join(host, source.mutationRoot, shard.id);
        const config = buildMutationShardConfig({
          base: JSON.parse(readFileSync(join(host, "stryker.config.json"), "utf8")),
          waveId: source.wave.wave_id,
          runId: ticket.mutation_run_id,
          manifestPath: mutationWave,
          repo: host,
          shard,
          workers: 2,
          dryRunTimeoutMinutes: 1,
        });
        const configText = JSON.stringify(config);
        const reportPath = join(directory, "mutation.json");
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as { config: unknown };
        report.config = config;
        const reportText = JSON.stringify(report);
        const receiptPath = join(directory, "receipt.json");
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
        Object.assign(receipt, {
          parent_validation_ticket_path: `reports/mutation/local-${host === hostA ? "a" : "b"}/ticket.json`,
          parent_validation_ticket_sha256: hash(`local-ticket:${host}`),
          distributed_ticket_sha256: ticketSha256,
          coordinator_commit_sha: commit,
          github_run_id: ticket.github_run_id,
          run_id: ticket.mutation_run_id,
          baseline_budget_ms: 60_000,
          dry_run_timeout_minutes: 1,
          runtime_snapshot_sha256: ticket.runtime_snapshot.sha256,
          runtime_artifact_digest_sha256: ticket.runtime_snapshot.artifact_digest_sha256,
          config_sha256: hash(configText),
          report_sha256: hash(reportText),
        });
        writeFileSync(join(directory, "stryker.json"), configText);
        writeFileSync(reportPath, reportText);
        writeFileSync(receiptPath, JSON.stringify(receipt));
      }
    }
    git(temporary, ["clone", "--quiet", "--no-hardlinks", source.root, collector]);
    collector = realpathSync(collector);
    const coordinatorInput = join(collector, "reports/quality-inputs/distributed");
    mkdirSync(coordinatorInput, { recursive: true });
    writeFileSync(join(coordinatorInput, "wave.json"), manifestText);
    writeFileSync(join(coordinatorInput, "ticket.json"), ticketText);
    const ledgerPath = join(collector, source.wave.dynamic_import_ledger_path);
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(
      ledgerPath,
      readFileSync(join(source.root, source.wave.dynamic_import_ledger_path), "utf8"),
    );
    restoreQualityArtifacts({
      repo: collector,
      source: coordinatorPackage,
      expectedIdentity: { commit, githubRunId: ticket.github_run_id, ticketSha256 },
    });
    expect(
      existsSync(join(collector, ticket.runtime_snapshot.path, "runtime-snapshot.seal.json")),
    ).toBe(false);
    const packageRoot = join(temporary, "packages");
    for (const [index, shard] of source.wave.shards.entries()) {
      const host = index % 2 === 0 ? hostA : hostB;
      const stampDirectory = join(
        host,
        "reports/mutation/runs",
        source.wave.wave_id,
        ticket.mutation_run_id,
        "validation-stamps",
      );
      mkdirSync(stampDirectory, { recursive: true });
      writeFileSync(join(stampDirectory, `${"a".repeat(64)}.json`), "{}\n");
      for (const name of ["test-baselines", "deadline-kills"]) {
        mkdirSync(join(dirname(stampDirectory), name), { recursive: true });
        writeFileSync(join(dirname(stampDirectory), name, `${shard.id}.jsonl`), "");
      }
      const produced = distributedShardPackageFiles({
        repo: host,
        waveId: source.wave.wave_id,
        coverageRunId: ticket.coverage_run_id,
        mutationRunId: ticket.mutation_run_id,
      });
      expect(
        existsSync(join(host, ticket.runtime_snapshot.path, "runtime-snapshot.seal.json")),
      ).toBe(true);
      expect(produced.filter((path) => path.includes("/runtime-snapshots/"))).toEqual([]);
      expect(produced.filter((path) => path.includes("/validation-stamps/"))).toEqual([]);
      expect(produced.filter((path) => path.includes("/test-baselines/"))).toEqual([]);
      expect(produced.filter((path) => path.includes("/deadline-kills/"))).toEqual([]);
      expect(produced.filter((path) => path.endsWith("/mutation-validation-ticket.json"))).toEqual(
        [],
      );
      const relativePaths = produced.filter(
        (path) =>
          path.startsWith(`${join(source.coverageRoot, shard.id)}/`) ||
          path.startsWith(`${join(source.mutationRoot, shard.id)}/`),
      );
      expect(relativePaths).toEqual(
        [
          ...files(join(host, source.coverageRoot, shard.id)).map((path) =>
            join(source.coverageRoot, shard.id, path),
          ),
          ...files(join(host, source.mutationRoot, shard.id)).map((path) =>
            join(source.mutationRoot, shard.id, path),
          ),
        ].sort(),
      );
      packQualityArtifacts({
        repo: host,
        destination: join(packageRoot, shard.id),
        files: relativePaths,
        identity: { commit, githubRunId: ticket.github_run_id, ticketSha256 },
      });
    }
    for (const shard of source.wave.shards)
      restoreQualityArtifacts({
        repo: collector,
        source: join(packageRoot, shard.id),
        expectedIdentity: { commit, githubRunId: ticket.github_run_id, ticketSha256 },
      });
    const coverageRoot = join(collector, source.coverageRoot);
    const mutationRoot = join(collector, source.mutationRoot);
    mkdirSync(coverageRoot, { recursive: true });
    mkdirSync(mutationRoot, { recursive: true });
    writeFileSync(join(coverageRoot, "wave.json"), manifestText);
    writeFileSync(join(mutationRoot, "wave.json"), manifestText);
    const coverageUnionPath = collectCoverageShardUnion({
      repo: collector,
      manifestPath: join(coordinatorInput, "wave.json"),
      runId: ticket.coverage_run_id,
      shardRoots: new Map(source.wave.shards.map((shard) => [shard.id, coverageRoot])),
      outputRoot: coverageRoot,
      distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
    });
    const prepared = prepareMutationShardExecution({
      repo: collector,
      manifestPath: join(coordinatorInput, "wave.json"),
      runId: ticket.mutation_run_id,
      root: mutationRoot,
    });
    expect(
      existsSync(join(collector, ticket.runtime_snapshot.path, "runtime-snapshot.seal.json")),
    ).toBe(true);
    const mutationShards = source.wave.shards.map((shard) => {
      const directory = join(mutationRoot, shard.id);
      const receiptText = readFileSync(join(directory, "receipt.json"), "utf8");
      return {
        id: shard.id,
        receiptText,
        configText: readFileSync(join(directory, "stryker.json"), "utf8"),
        reportText: readFileSync(join(directory, "mutation.json"), "utf8"),
        exitCode: JSON.parse(receiptText).exit_code as number,
      };
    });
    expect(
      collectMutationShardUnion({
        prepared,
        shards: mutationShards,
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }),
    ).toEqual([]);
    expect(() =>
      collectCoverageShardUnion({
        repo: collector,
        manifestPath: join(coordinatorInput, "wave.json"),
        runId: ticket.coverage_run_id,
        shardRoots: new Map(source.wave.shards.slice(1).map((shard) => [shard.id, coverageRoot])),
        outputRoot: join(collector, "reports/coverage/incomplete"),
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }),
    ).toThrow("missing shard root");
    expect(
      collectMutationShardUnion({
        prepared,
        shards: [...mutationShards, mutationShards[0]!],
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }).join("; "),
    ).toContain("duplicate shard result");
    const foreignReceipt = JSON.parse(mutationShards[0]!.receiptText) as Record<string, unknown>;
    foreignReceipt.github_run_id = "102";
    expect(
      collectMutationShardUnion({
        prepared,
        shards: [
          { ...mutationShards[0]!, receiptText: JSON.stringify(foreignReceipt) },
          ...mutationShards.slice(1),
        ],
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }).join("; "),
    ).toContain("distributed provenance invalid");
    const coverageReceiptPath = join(coverageRoot, source.wave.shards[0]!.id, "receipt.json");
    const originalCoverageReceipt = readFileSync(coverageReceiptPath, "utf8");
    const foreignCoverageReceipt = JSON.parse(originalCoverageReceipt) as Record<string, unknown>;
    foreignCoverageReceipt.github_run_id = "102";
    writeFileSync(coverageReceiptPath, json(foreignCoverageReceipt));
    expect(() =>
      collectCoverageShardUnion({
        repo: collector,
        manifestPath: join(coordinatorInput, "wave.json"),
        runId: ticket.coverage_run_id,
        shardRoots: new Map(source.wave.shards.map((shard) => [shard.id, coverageRoot])),
        outputRoot: join(collector, "reports/coverage/foreign"),
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }),
    ).toThrow("distributed provenance invalid");
    delete foreignCoverageReceipt.distributed_ticket_sha256;
    foreignCoverageReceipt.github_run_id = ticket.github_run_id;
    writeFileSync(coverageReceiptPath, json(foreignCoverageReceipt));
    expect(() =>
      collectCoverageShardUnion({
        repo: collector,
        manifestPath: join(coordinatorInput, "wave.json"),
        runId: ticket.coverage_run_id,
        shardRoots: new Map(source.wave.shards.map((shard) => [shard.id, coverageRoot])),
        outputRoot: join(collector, "reports/coverage/missing-binding"),
        distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
      }),
    ).toThrow("distributed provenance invalid");
    writeFileSync(coverageReceiptPath, originalCoverageReceipt);
    const mutationUnionPath = publishMutationShardUnion({
      prepared,
      shards: mutationShards,
      distributed: { ticket, ticketSha256, commit, githubRunId: ticket.github_run_id },
    });
    const acceptance = await verifyQualityShards({
      repo: collector,
      mutationUnionPath,
      coverageUnionPath,
      requireVersionedPolicy: true,
    });
    expect(existsSync(acceptance)).toBe(true);
    const bundle = join(collector, "reports/quality-export/shards");
    const index = await exportShardQualityEvidence({
      repo: collector,
      mutationUnionPath,
      coverageUnionPath,
      destination: bundle,
    });
    expect(existsSync(index)).toBe(true);
    let checkout = join(temporary, "release-checkout");
    git(temporary, ["clone", "--quiet", "--no-hardlinks", collector, checkout]);
    checkout = realpathSync(checkout);
    cpSync(bundle, checkout, { recursive: true });
    mkdirSync(join(checkout, "reports/quality-export/shards"), { recursive: true });
    cpSync(
      join(bundle, "quality-bundle.json"),
      join(checkout, "reports/quality-export/shards/quality-bundle.json"),
    );
    const bundleIndex = parseQualityBundleIndex(
      JSON.parse(
        readFileSync(join(checkout, "reports/quality-export/shards/quality-bundle.json"), "utf8"),
      ),
      commit,
    );
    expect(() => validatePortableParentValidationTicket(checkout, bundleIndex)).not.toThrow();
    expect(() =>
      validatePortableParentValidationTicket(checkout, bundleIndex, "foreign-run"),
    ).toThrow("foreign quality producer");
    expect(() =>
      validatePortableParentValidationTicket(checkout, {
        ...bundleIndex,
        files: bundleIndex.files.filter(
          (file) => file.path !== "reports/quality-inputs/distributed/ticket.json",
        ),
      }),
    ).toThrow("bundle omits distributed quality ticket");
    const distributedReceiptPath = join(
      checkout,
      source.mutationRoot,
      source.wave.shards[0]!.id,
      "receipt.json",
    );
    const originalDistributedReceipt = readFileSync(distributedReceiptPath, "utf8");
    const foreignDistributedReceipt = JSON.parse(originalDistributedReceipt) as Record<
      string,
      unknown
    >;
    foreignDistributedReceipt.distributed_ticket_sha256 = "0".repeat(64);
    writeFileSync(distributedReceiptPath, json(foreignDistributedReceipt));
    expect(() => validatePortableParentValidationTicket(checkout, bundleIndex)).toThrow(
      "disagree on distributed ticket binding",
    );
    writeFileSync(distributedReceiptPath, originalDistributedReceipt);
    const partialLocalReceipt = JSON.parse(originalDistributedReceipt) as Record<string, unknown>;
    delete partialLocalReceipt.parent_validation_ticket_sha256;
    writeFileSync(distributedReceiptPath, json(partialLocalReceipt));
    expect(() => validatePortableParentValidationTicket(checkout, bundleIndex)).toThrow(
      "partial local parent ticket",
    );
    writeFileSync(distributedReceiptPath, originalDistributedReceipt);
    expect(
      await verifyShardQualityBundle(
        checkout,
        commit,
        "reports/quality-export/shards/quality-bundle.json",
      ),
    ).toContain("acceptance-");
    const report = join(checkout, source.mutationRoot, source.wave.shards[0]!.id, "mutation.json");
    writeFileSync(report, "tampered");
    await expect(
      verifyShardQualityBundle(
        checkout,
        commit,
        "reports/quality-export/shards/quality-bundle.json",
      ),
    ).rejects.toThrow("Quality bundle file changed");
    const foreignPackage = join(packageRoot, source.wave.shards[0]!.id);
    writeFileSync(
      join(foreignPackage, "files", source.coverageRoot, source.wave.shards[0]!.id, "receipt.json"),
      "tampered",
    );
    expect(() =>
      restoreQualityArtifacts({
        repo: join(temporary, "foreign"),
        source: foreignPackage,
        expectedIdentity: { commit, githubRunId: ticket.github_run_id, ticketSha256 },
      }),
    ).toThrow("hash");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});
