import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mutationTestInputs } from "../../audit/mutation-inputs.ts";
import {
  createMutationRuntimeSnapshot,
  MUTATION_RUNTIME_ARTIFACTS,
  mutationRuntimeArtifactDigest,
  sealMutationRuntimeSnapshot,
} from "../../audit/mutation-runtime-snapshot.ts";
import { digestWaveFiles, type MutationWaveManifest } from "../../audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  EXPLICIT_PURE_TARGET_PATHS,
  REVIEWED_ENGINE_CORE_TARGET_PATHS,
} from "../../audit/pure-targets.ts";

export function frozenWaveFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subkit-mutation-preflight-")));
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const targets = [...EXPLICIT_PURE_TARGET_PATHS, ...REVIEWED_ENGINE_CORE_TARGET_PATHS].sort();
  const tests = targets.map((target) => target.replace(/\.ts$/, ".test.ts"));
  put("package.json", '{"patchedDependencies":{}}\n');
  for (const path of MUTATION_RUNTIME_ARTIFACTS) put(path, `fixture:${path}\n`);
  writeFileSync(join(root, "dist/subkit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, "dist/subkit"), 0o755);
  for (const [index, target] of targets.entries()) {
    put(target, "export const fixture = true;\n");
    put(tests[index]!, `import { fixture } from "./${target.split("/").at(-1)}"; void fixture;\n`);
  }
  for (const file of mutationTestInputs(root)) {
    if (file !== "package.json" && !targets.includes(file) && !tests.includes(file))
      put(file, "\n");
  }
  put(
    "stryker.config.json",
    readFileSync(new URL("../../../../../stryker.config.json", import.meta.url), "utf8"),
  );
  put("apps/engine/.mutation-equivalents.json", '{"version":1,"equivalents":[]}');
  put(".artifacts/ledger.json", '{"version":1,"entries":[]}');
  const entries = assertCompletePureTargetInventory(targets);
  const runtimeArtifactDigest = mutationRuntimeArtifactDigest(root);
  const wave: MutationWaveManifest = {
    version: 1,
    wave_id: "preflight-fixture",
    source_freeze_sha256: digestWaveFiles(root, mutationTestInputs(root)),
    runtime_artifact_digest_sha256: runtimeArtifactDigest,
    test_freeze_sha256: digestWaveFiles(root, tests),
    target_digest_sha256: canonicalPureTargetDigest(entries),
    config_sha256: digestWaveFiles(root, ["stryker.config.json"]),
    lock_sha256: digestWaveFiles(root, ["bun.lock"]),
    equivalence_manifest_path: "apps/engine/.mutation-equivalents.json",
    equivalence_manifest_sha256: digestWaveFiles(root, ["apps/engine/.mutation-equivalents.json"]),
    dynamic_import_ledger_path: ".artifacts/ledger.json",
    dynamic_import_ledger_sha256: digestWaveFiles(root, [".artifacts/ledger.json"]),
    non_incremental: true,
    worker_budget: 2,
    shards: [
      {
        id: "fixture",
        targets,
        tests: tests.map((path, index) => ({
          path,
          kind: "direct",
          covers_targets: [targets[index]!],
          rationale: "direct fixture import",
        })),
        consumers: [],
        resource_tags: [],
      },
    ],
  };
  const manifestPath = join(root, ".artifacts/wave.json");
  writeFileSync(manifestPath, JSON.stringify(wave));
  return { root, manifestPath, targets, tests, put, wave };
}

export function frozenWaveRuntimeSnapshot(input: {
  root: string;
  parentRunRoot: string;
  wave: MutationWaveManifest;
  manifestText: string;
  runId: string;
}) {
  const snapshot = createMutationRuntimeSnapshot({
    repo: input.root,
    parentRunRoot: input.parentRunRoot,
    waveId: input.wave.wave_id,
    runId: input.runId,
    sourceFreezeSha256: input.wave.source_freeze_sha256,
    manifestSha256: createHash("sha256").update(input.manifestText).digest("hex"),
    artifactDigestSha256: input.wave.runtime_artifact_digest_sha256!,
  });
  return {
    ...snapshot,
    sealSha256: sealMutationRuntimeSnapshot({
      path: snapshot.path,
      sha256: snapshot.sha256,
      expected: {
        wave_id: input.wave.wave_id,
        run_id: input.runId,
        source_freeze_sha256: input.wave.source_freeze_sha256,
        manifest_sha256: createHash("sha256").update(input.manifestText).digest("hex"),
        artifact_digest_sha256: input.wave.runtime_artifact_digest_sha256!,
      },
    }),
  };
}
