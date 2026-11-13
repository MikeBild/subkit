import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  packQualityArtifacts,
  restoreQualityArtifacts,
} from "../audit/distributed-quality-artifacts.ts";
import {
  type DistributedQualityTicketV2,
  distributedRuntimeSnapshot,
  parseDistributedQualityTicket,
} from "../audit/distributed-quality-ticket.ts";
import {
  createMutationRuntimeSnapshot,
  MUTATION_RUNTIME_ARTIFACTS,
  mutationRuntimeArtifactDigest,
  provisionMutationRuntimeSnapshot,
  rehydrateMutationRuntimeSnapshot,
  sealMutationRuntimeSnapshot,
} from "../audit/mutation-runtime-snapshot.ts";
import { portableRuntimeSnapshotFiles } from "../distributed-quality.ts";

const owned: string[] = [];
const sha = (char: string) => char.repeat(64);
const commit = "a".repeat(40);
const identity = { commit, githubRunId: "123", ticketSha256: sha("b") };

afterEach(() => {
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runtimeFixture() {
  const source = realpathSync(mkdtempSync(join(tmpdir(), "runtime-snapshot-transport-source-")));
  const shard = realpathSync(mkdtempSync(join(tmpdir(), "runtime-snapshot-transport-shard-")));
  const packageRoot = join(
    mkdtempSync(join(tmpdir(), "runtime-snapshot-transport-package-")),
    "package",
  );
  owned.push(source, shard, dirname(packageRoot));
  for (const [index, path] of MUTATION_RUNTIME_ARTIFACTS.entries()) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      path === "dist/sk" ? "#!/bin/sh\nprintf 'runtime-cli\\n'\n" : `runtime-${index}\n`,
    );
    if (path === "dist/sk") chmodSync(target, 0o755);
  }
  const waveId = "wave-transport";
  const runId = "run-mutation-transport";
  const parent = join(source, "reports/mutation/runs", waveId, runId);
  mkdirSync(parent, { recursive: true });
  const snapshot = createMutationRuntimeSnapshot({
    repo: source,
    parentRunRoot: parent,
    waveId,
    runId,
    sourceFreezeSha256: sha("c"),
    manifestSha256: sha("d"),
    artifactDigestSha256: mutationRuntimeArtifactDigest(source),
  });
  const snapshotExpected = {
    wave_id: waveId,
    run_id: runId,
    source_freeze_sha256: sha("c"),
    manifest_sha256: sha("d"),
    artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
  };
  const coordinatorSeal = sealMutationRuntimeSnapshot({
    path: snapshot.path,
    sha256: snapshot.sha256,
    expected: snapshotExpected,
  });
  const ticket: DistributedQualityTicketV2 = {
    version: 2,
    coordinator_commit_sha: commit,
    github_run_id: "123",
    coverage_run_id: "run-coverage-transport",
    mutation_run_id: runId,
    manifest_path: "reports/quality-inputs/distributed/wave.json",
    ticket_path: "reports/quality-inputs/distributed/ticket.json",
    wave_id: waveId,
    manifest_sha256: sha("d"),
    source_sha256: sha("c"),
    test_sha256: sha("e"),
    config_sha256: sha("f"),
    lock_sha256: sha("1"),
    target_digest_sha256: sha("2"),
    quality_policy_sha256: sha("3"),
    dynamic_import_ledger_sha256: sha("4"),
    equivalence_manifest_sha256: sha("5"),
    campaign_timeout_ms: 60_000,
    shards: [{ id: "shared", targets_sha256: sha("6"), baseline_budget_ms: 60_000 }],
    runtime_snapshot: {
      path: relative(source, snapshot.path),
      sha256: snapshot.sha256,
      artifact_digest_sha256: snapshot.snapshot.artifact_digest_sha256,
      artifacts: snapshot.snapshot.artifacts.map((artifact) => ({ ...artifact })),
    },
  };
  const ticketPath = join(source, ticket.ticket_path);
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(ticketPath, `${JSON.stringify(ticket)}\n`);
  const snapshotFiles = portableRuntimeSnapshotFiles({
    repo: source,
    snapshotPath: snapshot.path,
    artifacts: snapshot.snapshot.artifacts,
  });
  packQualityArtifacts({
    repo: source,
    destination: packageRoot,
    files: [ticket.ticket_path, ...snapshotFiles].sort(),
    identity,
  });
  return { source, shard, packageRoot, snapshot, snapshotExpected, coordinatorSeal, ticket };
}

test("coordinator snapshot package restores and rehydrates the ticket-bound executable runtime", () => {
  const f = runtimeFixture();
  restoreQualityArtifacts({ repo: f.shard, source: f.packageRoot, expectedIdentity: identity });
  const ticket = parseDistributedQualityTicket(
    JSON.parse(
      readFileSync(join(f.shard, "reports/quality-inputs/distributed/ticket.json"), "utf8"),
    ),
  );
  const bound = distributedRuntimeSnapshot(ticket);
  const snapshotPath = join(f.shard, bound.path);
  expect(existsSync(join(snapshotPath, "runtime-snapshot.seal.json"))).toBe(false);
  for (const artifact of MUTATION_RUNTIME_ARTIFACTS)
    expect(lstatSync(join(snapshotPath, artifact)).mode & 0o777).toBe(0o600);
  rehydrateMutationRuntimeSnapshot({
    path: snapshotPath,
    sha256: bound.sha256,
    expected: {
      wave_id: ticket.wave_id,
      run_id: ticket.mutation_run_id,
      source_freeze_sha256: ticket.source_sha256,
      manifest_sha256: ticket.manifest_sha256,
      artifact_digest_sha256: bound.artifact_digest_sha256,
    },
  });
  const shardSeal = sealMutationRuntimeSnapshot({
    path: snapshotPath,
    sha256: bound.sha256,
    expected: f.snapshotExpected,
  });
  expect(shardSeal).not.toBe(f.coordinatorSeal);
  const sandbox = join(f.shard, ".stryker-tmp", "sandbox");
  mkdirSync(sandbox, { recursive: true });
  provisionMutationRuntimeSnapshot({
    sandboxRepo: sandbox,
    snapshotPath,
    snapshotSha256: bound.sha256,
    sealSha256: shardSeal,
    expected: {
      wave_id: ticket.wave_id,
      run_id: ticket.mutation_run_id,
      source_freeze_sha256: ticket.source_sha256,
      manifest_sha256: ticket.manifest_sha256,
      artifact_digest_sha256: bound.artifact_digest_sha256,
    },
  });
  expect(existsSync(join(f.shard, "dist/sk"))).toBe(false);
  const executable = join(sandbox, "dist/sk");
  expect(lstatSync(executable).isSymbolicLink()).toBe(true);
  expect(execFileSync(executable, { encoding: "utf8" })).toBe("runtime-cli\n");
  expect((lstatSync(join(snapshotPath, "dist/sk")).mode & 0o111) !== 0).toBe(true);
  for (const artifact of MUTATION_RUNTIME_ARTIFACTS.filter((path) => path !== "dist/sk"))
    expect(lstatSync(join(snapshotPath, artifact)).mode & 0o111).toBe(0);
  for (const artifact of MUTATION_RUNTIME_ARTIFACTS)
    expect(lstatSync(join(sandbox, artifact)).isSymbolicLink()).toBe(true);
});

test("transport rejects tampered and missing snapshot blobs before rehydration", () => {
  const f = runtimeFixture();
  const blob = join(f.packageRoot, "files", relative(f.source, f.snapshot.path), "dist/sk");
  writeFileSync(blob, "tampered\n");
  expect(() =>
    restoreQualityArtifacts({ repo: f.shard, source: f.packageRoot, expectedIdentity: identity }),
  ).toThrow("hash");
  unlinkSync(blob);
  expect(() =>
    restoreQualityArtifacts({ repo: f.shard, source: f.packageRoot, expectedIdentity: identity }),
  ).toThrow();
  expect(existsSync(join(f.shard, "dist/sk"))).toBe(false);
});

test("transport rejects an extra blob and a snapshot bound to a foreign wave", () => {
  const f = runtimeFixture();
  restoreQualityArtifacts({ repo: f.shard, source: f.packageRoot, expectedIdentity: identity });
  const bound = distributedRuntimeSnapshot(f.ticket);
  const snapshotPath = join(f.shard, bound.path);
  writeFileSync(join(snapshotPath, "extra.bin"), "not in the closure\n");
  expect(() =>
    rehydrateMutationRuntimeSnapshot({
      path: snapshotPath,
      sha256: bound.sha256,
      expected: {
        wave_id: f.ticket.wave_id,
        run_id: f.ticket.mutation_run_id,
        source_freeze_sha256: f.ticket.source_sha256,
        manifest_sha256: f.ticket.manifest_sha256,
        artifact_digest_sha256: bound.artifact_digest_sha256,
      },
    }),
  ).toThrow("unexpected");
  const clean = runtimeFixture();
  restoreQualityArtifacts({
    repo: clean.shard,
    source: clean.packageRoot,
    expectedIdentity: identity,
  });
  const cleanBound = distributedRuntimeSnapshot(clean.ticket);
  expect(() =>
    rehydrateMutationRuntimeSnapshot({
      path: join(clean.shard, cleanBound.path),
      sha256: cleanBound.sha256,
      expected: {
        wave_id: "foreign-wave",
        run_id: clean.ticket.mutation_run_id,
        source_freeze_sha256: clean.ticket.source_sha256,
        manifest_sha256: clean.ticket.manifest_sha256,
        artifact_digest_sha256: cleanBound.artifact_digest_sha256,
      },
    }),
  ).toThrow("wave_id");
});
