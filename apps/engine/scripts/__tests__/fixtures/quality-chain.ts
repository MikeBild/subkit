import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitVisibleSourceDigest } from "../../../../../scripts/lib/source-digest.ts";
import { externalRuntimeDockerTests } from "../../audit/external-runtime-tests.ts";
import { mutationTestInputs } from "../../audit/mutation-inputs.ts";
import {
  createMutationRuntimeSnapshot,
  MUTATION_RUNTIME_ARTIFACTS,
  mutationRuntimeArtifactDigest,
  sealMutationRuntimeSnapshot,
} from "../../audit/mutation-runtime-snapshot.ts";
import { buildMutationShardConfig } from "../../audit/mutation-shard-config.ts";
import { digestWaveFiles } from "../../audit/mutation-wave.ts";
import { assertCompletePureTargetInventory } from "../../audit/pure-targets.ts";
import { frozenWaveFixture } from "./frozen-wave.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function qualityChainFixture(
  policyBound = false,
  externalRuntime = false,
  equivalentSurvivor = false,
  behaviorEvidence = false,
) {
  const f = frozenWaveFixture();
  const { wave, put, root } = f;
  for (const [index, path] of MUTATION_RUNTIME_ARTIFACTS.entries()) {
    put(path, path === "dist/sk" ? "#!/bin/sh\nexit 0\n" : `runtime-fixture-${index}\n`);
    if (path === "dist/sk") chmodSync(join(root, path), 0o755);
  }
  wave.runtime_artifact_digest_sha256 = mutationRuntimeArtifactDigest(root);
  if (behaviorEvidence) wave.shards[0]!.tests[0]!.kind = "reverse_import";
  const allTargets = f.targets;
  const equivalentTarget = allTargets[0]!;
  const equivalentSource = "export const fixture = (true ? 1 : 1);\n";
  const location = { start: { line: 1, column: 25 }, end: { line: 1, column: 29 } };
  if (equivalentSurvivor) {
    put(equivalentTarget, equivalentSource);
    put(
      wave.equivalence_manifest_path,
      JSON.stringify({
        version: 1,
        equivalents: [
          {
            file: equivalentTarget,
            source_sha256: hash(equivalentSource),
            location,
            mutatorName: "BooleanLiteral",
            replacement: "false",
            original: "true",
            status: "Survived",
            statusReason: "",
            reason: "Both conditional arms return the same literal.",
            independent_review:
              "Fixture proves both arms have the same returned value and no effects.",
          },
        ],
      }),
    );
    wave.equivalence_manifest_sha256 = digestWaveFiles(root, [wave.equivalence_manifest_path]);
    wave.source_freeze_sha256 = digestWaveFiles(root, mutationTestInputs(root));
  }

  if (externalRuntime) {
    put("tests/docker/fixture.docker.test.ts", "export {}\n");
    wave.external_runtime_tests = externalRuntimeDockerTests(root);
  }
  if (policyBound) {
    const entries = assertCompletePureTargetInventory(allTargets);
    const owners = [...new Set(entries.map((entry) => entry.owner_shard))].sort();
    const tests = wave.shards[0]!.tests;
    wave.shards = owners.map((id) => {
      const targets = entries
        .filter((entry) => entry.owner_shard === id)
        .map((entry) => entry.path);
      return {
        id,
        targets,
        tests: tests.filter((test) =>
          test.covers_targets.some((target) => targets.includes(target)),
        ),
        consumers: [],
        resource_tags: ["db"],
      };
    });
    const policyPath = "apps/engine/.quality-shard-policy.json";
    put(
      policyPath,
      JSON.stringify({
        version: 1,
        worker_budget: wave.worker_budget,
        equivalence_manifest_path: wave.equivalence_manifest_path,
        shards: wave.shards.map(({ id, resource_tags }) => ({ id, resource_tags })),
      }),
    );
    put(
      wave.dynamic_import_ledger_path,
      JSON.stringify({ version: 1, entries: [], runtime_witnesses: [] }),
    );
    wave.quality_policy_sha256 = digestWaveFiles(root, [policyPath]);
    wave.dynamic_import_ledger_sha256 = digestWaveFiles(root, [wave.dynamic_import_ledger_path]);
    wave.source_freeze_sha256 = digestWaveFiles(root, mutationTestInputs(root));
  }
  const manifestText = JSON.stringify(wave);
  const manifestHash = hash(manifestText);
  const mutationRoot = "reports/mutation/runs/preflight-fixture/run-mutation";
  const coverageRoot = "reports/coverage/shards/preflight-fixture/run-coverage";
  put(`${mutationRoot}/wave.json`, manifestText);
  put(`${coverageRoot}/wave.json`, manifestText);
  const runtimeSnapshot = createMutationRuntimeSnapshot({
    repo: root,
    parentRunRoot: join(root, mutationRoot),
    waveId: wave.wave_id,
    runId: "run-mutation",
    sourceFreezeSha256: wave.source_freeze_sha256,
    manifestSha256: manifestHash,
    artifactDigestSha256: wave.runtime_artifact_digest_sha256!,
  });
  const runtimeSnapshotSeal = sealMutationRuntimeSnapshot({
    path: runtimeSnapshot.path,
    sha256: runtimeSnapshot.sha256,
    expected: {
      wave_id: wave.wave_id,
      run_id: "run-mutation",
      source_freeze_sha256: wave.source_freeze_sha256,
      manifest_sha256: manifestHash,
      artifact_digest_sha256: wave.runtime_artifact_digest_sha256!,
    },
  });
  let nativeRoot = "";
  for (const shard of wave.shards) {
    const targets = shard.targets;
    const config = buildMutationShardConfig({
      base: JSON.parse(readFileSync(join(root, "stryker.config.json"), "utf8")),
      waveId: wave.wave_id,
      runId: "run-mutation",
      manifestPath: join(root, mutationRoot, "wave.json"),
      shard,
      ...(policyBound ? { repo: root } : {}),
      workers: 2,
    });
    const configText = JSON.stringify(config);
    const reportText = JSON.stringify({
      config,
      files: Object.fromEntries(
        targets.map((target) => [
          target,
          {
            source: readFileSync(join(root, target), "utf8"),
            mutants: [
              { status: "Killed" },
              ...(equivalentSurvivor && target === equivalentTarget
                ? [
                    {
                      status: "Survived",
                      mutatorName: "BooleanLiteral",
                      replacement: "false",
                      location,
                    },
                  ]
                : []),
            ],
          },
        ]),
      ),
    });
    put(`${mutationRoot}/${shard.id}/stryker.json`, configText);
    put(`${mutationRoot}/${shard.id}/mutation.json`, reportText);
    const common = {
      version: 1,
      wave_id: wave.wave_id,
      shard_id: shard.id,
      manifest_sha256: manifestHash,
      source_sha256: wave.source_freeze_sha256,
      test_sha256: wave.test_freeze_sha256,
      target_digest_sha256: wave.target_digest_sha256,
      base_config_sha256: wave.config_sha256,
      targets,
      runtime_targets: targets,
      type_only_targets: [],
    };
    put(
      `${mutationRoot}/${shard.id}/receipt.json`,
      JSON.stringify({
        ...common,
        run_id: "run-mutation",
        config_sha256: hash(configText),
        report_sha256: hash(reportText),
        canonical_target_sha256: wave.target_digest_sha256,
        lock_sha256: wave.lock_sha256,
        equivalence_manifest_sha256: wave.equivalence_manifest_sha256,
        dynamic_import_ledger_sha256: wave.dynamic_import_ledger_sha256,
        runtime_artifact_digest_sha256: wave.runtime_artifact_digest_sha256,
        runtime_snapshot_sha256: runtimeSnapshot.sha256,
        workers: 2,
        exit_code: equivalentSurvivor && targets.includes(equivalentTarget) ? 1 : 0,
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:01Z",
      }),
    );
    const proofs = targets.map((target) => {
      const lcov = `SF:${target}\nFN:1,f\nFNDA:1,f\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`;
      return { target, path: `targets/${hash(target)}.lcov`, sha256: hash(lcov), lcov };
    });
    const refs = proofs.map(({ lcov: _lcov, ...ref }) => ref);
    nativeRoot = `${coverageRoot}/${shard.id}/coverage/runs/native-fixture-run`;
    for (const proof of proofs) put(`${nativeRoot}/${proof.path}`, proof.lcov);
    const lcovText = proofs.map((proof) => proof.lcov).join("");
    const coverageConfig = hash("coverage-config");
    const behavior =
      behaviorEvidence && shard.tests.some((test) => test.kind !== "direct")
        ? (() => {
            const base = `.artifacts/behavior/${shard.id}`;
            const manifest = JSON.stringify({ status: "passed" });
            const result = JSON.stringify({
              status: "passed",
              test: shard.tests[0]!.path,
              context_sha256: "e".repeat(64),
              outcome: { exitCode: 0, timedOut: false, error: null },
            });
            const log = "native behavior output\n";
            put(`${base}/manifest.json`, manifest);
            put(`${base}/result.json`, result);
            put(`${base}/runner.log`, log);
            const text = JSON.stringify({
              version: 2,
              wave_id: wave.wave_id,
              manifest_sha256: manifestHash,
              source_sha256: wave.source_freeze_sha256,
              test_sha256: wave.test_freeze_sha256,
              config_sha256: wave.config_sha256,
              context_sha256: "e".repeat(64),
              resource_tags: shard.resource_tags,
              tests: [shard.tests[0]!.path],
              executed_tests: [shard.tests[0]!.path],
              terminal: [
                {
                  test: shard.tests[0]!.path,
                  manifest_path: `${base}/manifest.json`,
                  manifest_sha256: hash(manifest),
                  result_path: `${base}/result.json`,
                  result_sha256: hash(result),
                  log_path: `${base}/runner.log`,
                  log_sha256: hash(log),
                },
              ],
            });
            return { sha256: hash(text), text };
          })()
        : undefined;
    const provenanceText = JSON.stringify({
      version: 4,
      wave_id: wave.wave_id,
      shard_id: shard.id,
      manifest_sha256: manifestHash,
      wave_source_freeze_sha256: wave.source_freeze_sha256,
      wave_test_freeze_sha256: wave.test_freeze_sha256,
      wave_target_digest_sha256: wave.target_digest_sha256,
      wave_base_config_sha256: wave.config_sha256,
      config_sha256: coverageConfig,
      direct_target_evidence: refs,
      ...(behavior ? { behavior_evidence: behavior } : {}),
    });
    const nativeReceiptText = JSON.stringify({
      version: 1,
      run_id: "native-fixture-run",
      lcov: { path: "lcov.info", sha256: hash(lcovText) },
      provenance: { path: "provenance.json", sha256: hash(provenanceText) },
      direct_target_evidence: refs,
    });
    put(`${nativeRoot}/lcov.info`, lcovText);
    put(`${nativeRoot}/provenance.json`, provenanceText);
    put(`${nativeRoot}/receipt.json`, nativeReceiptText);
    put(
      `${coverageRoot}/${shard.id}/coverage/latest.json`,
      JSON.stringify({
        version: 1,
        run_id: "native-fixture-run",
        receipt: "runs/native-fixture-run/receipt.json",
        receipt_sha256: hash(nativeReceiptText),
      }),
    );
    put(
      `${coverageRoot}/${shard.id}/receipt.json`,
      JSON.stringify({
        ...common,
        run_id: "run-coverage",
        coverage_config_sha256: coverageConfig,
        native_receipt_sha256: hash(nativeReceiptText),
        native_provenance_sha256: hash(provenanceText),
        native_lcov_sha256: hash(lcovText),
        direct_target_evidence: proofs,
      }),
    );
  }
  for (const [path, id] of [
    [mutationRoot, "run-mutation"],
    [coverageRoot, "run-coverage"],
  ])
    put(
      `${path}/union.json`,
      JSON.stringify({
        version: 1,
        wave_id: wave.wave_id,
        manifest_sha256: manifestHash,
        run_id: id,
        target_count: allTargets.length,
        shards: wave.shards.map((shard) => ({
          id: shard.id,
          receipt_sha256: hash(readFileSync(join(root, path!, shard.id, "receipt.json"), "utf8")),
        })),
      }),
    );
  const externalRoot = `reports/external-runtime/runs/${wave.wave_id}/fixture-run`;
  const createExternalRuntimeAcceptance = () => {
    if (!externalRuntime) throw new Error("external runtime fixture was not requested");
    const tests = externalRuntimeDockerTests(root);
    const visible = gitVisibleSourceDigest(root).digest;
    const command = (mode: "cold" | "warm") => {
      const builds = Array.from({ length: 5 }, (_, index) => {
        const attempt = index + 1;
        const native = {
          project: `fixture-${mode}-${attempt}`,
          image_id: `sha256:${attempt.toString(16).repeat(64)}`,
          platform: "linux/amd64",
          source: { digest: visible },
          context: { digest: "c".repeat(64) },
        };
        const receiptPath = `${mode}.build-index.json.receipts/${attempt}.json`;
        const nativeText = JSON.stringify(native);
        put(`${externalRoot}/${receiptPath}`, nativeText);
        return {
          attempt,
          project: native.project,
          image_id: native.image_id,
          platform: native.platform,
          source: native.source,
          context_digest: native.context.digest,
          receipt_path: receiptPath,
          receipt_sha256: hash(nativeText),
        };
      });
      const indexText = JSON.stringify({ mode, repeat: 5, tests, builds });
      const build_index_path = `${externalRoot}/${mode}.build-index.json`;
      put(build_index_path, indexText);
      return {
        mode,
        repeat: 5 as const,
        exit_code: 0 as const,
        build_index_path,
        build_index_sha256: hash(indexText),
      };
    };
    const acceptancePath = `${externalRoot}/acceptance.json`;
    put(
      acceptancePath,
      JSON.stringify({
        version: 1,
        wave_id: wave.wave_id,
        manifest_sha256: manifestHash,
        source_sha256: wave.source_freeze_sha256,
        test_sha256: wave.test_freeze_sha256,
        git_source_digest: visible,
        tests,
        commands: [command("cold"), command("warm")],
      }),
    );
    return acceptancePath;
  };
  return {
    ...f,
    mutationRoot,
    coverageRoot,
    nativeRoot,
    runtimeSnapshot,
    runtimeSnapshotSeal,
    createExternalRuntimeAcceptance,
    options: {
      repo: root,
      mutationUnionPath: join(root, mutationRoot, "union.json"),
      coverageUnionPath: join(root, coverageRoot, "union.json"),
    },
  };
}
