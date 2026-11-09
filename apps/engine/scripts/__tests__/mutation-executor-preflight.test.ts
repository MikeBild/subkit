import { afterEach, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import { mutationTestInputs } from "../audit/mutation-inputs.ts";
import { digestWaveFiles, type MutationWaveManifest } from "../audit/mutation-wave.ts";
import {
  assertCompletePureTargetInventory,
  canonicalPureTargetDigest,
  EXPLICIT_PURE_TARGET_PATHS,
  REVIEWED_ENGINE_CORE_TARGET_PATHS,
} from "../audit/pure-targets.ts";
import {
  ensurePersistentStrykerTempParent,
  loadMutationWave,
  parseMutationExecutorArgs,
} from "../run-mutation-shards.ts";

const roots: string[] = [];
test("mutation execution requires an unambiguous explicit run mode", () => {
  expect(parseMutationExecutorArgs(["--manifest", "wave.json"])).toEqual({
    manifest: "wave.json",
    mode: "plan",
  });
  expect(parseMutationExecutorArgs(["--run", "--manifest", "wave.json"])).toEqual({
    manifest: "wave.json",
    mode: "run",
  });
  for (const args of [
    ["--manifest", "wave.json", "--plan", "--run"],
    ["--manifest", "wave.json", "--plan", "--plan"],
    ["--manifest", "wave.json", "--run", "--run"],
    ["--manifest", "wave.json", "--manifest", "other.json"],
    ["--manifest", "--run"],
    ["--run"],
    ["--manifest", "wave.json", "--force"],
  ])
    expect(() => parseMutationExecutorArgs(args)).toThrow();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("creates a persistent owned marker for the shared Stryker sandbox parent", () => {
  const root = mkdtempSync(join(tmpdir(), "subkit-mutation-temp-parent-"));
  roots.push(root);
  ensurePersistentStrykerTempParent(root);
  const marker = join(root, ".stryker-tmp", ".subkit-owned-parent");
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("subkit persistent stryker temp parent v1\n");
  ensurePersistentStrykerTempParent(root);
  writeFileSync(marker, "foreign\n");
  expect(() => ensurePersistentStrykerTempParent(root)).toThrow(
    "Stryker temp parent marker is not owned by Subkit",
  );
});

test("refuses symlinked Stryker parent and marker paths before writing", () => {
  const parentRoot = mkdtempSync(join(tmpdir(), "subkit-mutation-temp-parent-link-"));
  roots.push(parentRoot);
  const parentTarget = join(parentRoot, "foreign-parent");
  mkdirSync(parentTarget);
  symlinkSync(parentTarget, join(parentRoot, ".stryker-tmp"));
  expect(() => ensurePersistentStrykerTempParent(parentRoot)).toThrow(
    "Stryker temp parent is not an owned directory",
  );

  const markerRoot = mkdtempSync(join(tmpdir(), "subkit-mutation-temp-marker-link-"));
  roots.push(markerRoot);
  const markerParent = join(markerRoot, ".stryker-tmp");
  mkdirSync(markerParent);
  const markerTarget = join(markerRoot, "foreign-marker");
  writeFileSync(markerTarget, "subkit persistent stryker temp parent v1\n");
  symlinkSync(markerTarget, join(markerParent, ".subkit-owned-parent"));
  expect(() => ensurePersistentStrykerTempParent(markerRoot)).toThrow(
    "Stryker temp parent marker is not owned by Subkit",
  );
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subkit-mutation-preflight-"));
  roots.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const targets = [...EXPLICIT_PURE_TARGET_PATHS, ...REVIEWED_ENGINE_CORE_TARGET_PATHS].sort();
  const tests = targets.map((target) => target.replace(/\.ts$/, ".test.ts"));
  for (const [index, target] of targets.entries()) {
    put(target, "export const fixture = true;\n");
    put(tests[index]!, `import { fixture } from "./${target.split("/").at(-1)}"; void fixture;\n`);
  }
  for (const file of mutationTestInputs(root)) {
    if (!targets.includes(file) && !tests.includes(file)) put(file, "\n");
  }
  put(
    "stryker.config.json",
    readFileSync(new URL("../../../../stryker.config.json", import.meta.url), "utf8"),
  );
  put("apps/engine/.mutation-equivalents.json", '{"version":1,"equivalents":[]}');
  put(".artifacts/ledger.json", '{"version":1,"entries":[]}');
  const entries = assertCompletePureTargetInventory(targets);
  const wave: MutationWaveManifest = {
    version: 1,
    wave_id: "preflight-fixture",
    source_freeze_sha256: digestWaveFiles(root, mutationTestInputs(root)),
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

test("preflight admits a complete frozen inventory without launching mutation", () => {
  const { root, manifestPath, targets } = fixture();
  expect(loadMutationWave(root, manifestPath).entries.map((entry) => entry.path)).toEqual(targets);
});

test("fresh digests cannot certify a declared direct test without a target import", () => {
  const f = fixture();
  f.put(f.tests[0]!, "export const unrelated = true;");
  const wave = {
    ...f.wave,
    source_freeze_sha256: digestWaveFiles(f.root, mutationTestInputs(f.root)),
    test_freeze_sha256: digestWaveFiles(f.root, f.tests),
  };
  writeFileSync(f.manifestPath, JSON.stringify(wave));
  expect(() => loadMutationWave(f.root, f.manifestPath)).toThrow(
    "direct test has no target import",
  );
});

test("fresh digests cannot hide an omitted runtime consumer", () => {
  const { root, manifestPath, targets, put, wave } = fixture();
  const target = targets[0]!;
  const folder = dirname(target);
  const consumer = `${folder}/consumer.ts`;
  const witness = `${folder}/consumer.test.ts`;
  put(consumer, `export { fixture } from "./${target.split("/").at(-1)}";\n`);
  put(witness, 'import { fixture } from "./consumer.ts"; void fixture;\n');
  const shard = wave.shards[0]!;
  const tests = [
    ...shard.tests,
    {
      path: witness,
      kind: "reverse_import" as const,
      covers_targets: [target],
      rationale: "consumer import",
    },
  ];
  const updated = {
    ...wave,
    source_freeze_sha256: digestWaveFiles(root, mutationTestInputs(root)),
    test_freeze_sha256: digestWaveFiles(
      root,
      tests.map((test) => test.path),
    ),
    shards: [{ ...shard, tests }],
  };
  writeFileSync(manifestPath, JSON.stringify(updated));
  expect(() => loadMutationWave(root, manifestPath)).toThrow("omits production consumer");
  const wrongWitness = {
    ...updated,
    shards: [
      { ...updated.shards[0]!, consumers: [{ path: consumer, witnesses: [shard.tests[0]!.path] }] },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(wrongWitness));
  expect(() => loadMutationWave(root, manifestPath)).toThrow("no executable witness");
  const correctWitness = {
    ...updated,
    shards: [{ ...updated.shards[0]!, consumers: [{ path: consumer, witnesses: [witness] }] }],
  };
  writeFileSync(manifestPath, JSON.stringify(correctWitness));
  expect(loadMutationWave(root, manifestPath).wave.shards[0]!.consumers).toEqual(
    correctWitness.shards[0]!.consumers,
  );
});

test("preflight rejects missing registered targets and stale runtime, test, config or lock inputs", () => {
  for (const kind of [
    "missing",
    "source",
    "test",
    "config",
    "lock",
    "runner",
    "score_verifier",
    "ledger",
  ] as const) {
    const { root, manifestPath, targets, tests, put } = fixture();
    if (kind === "missing") rmSync(join(root, targets[0]!));
    else {
      const path = {
        source: targets[0]!,
        test: tests[0]!,
        config: "stryker.config.json",
        lock: "bun.lock",
        runner: "apps/engine/scripts/run-mutation-shards.ts",
        score_verifier: "apps/engine/scripts/audit/mutation-shard-score.ts",
        ledger: ".artifacts/ledger.json",
      }[kind];
      put(path, "changed\n");
    }
    expect(() => loadMutationWave(root, manifestPath)).toThrow();
  }
});
