import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { mutationClosureFiles, mutationTestInputs } from "../audit/mutation-inputs.ts";
import {
  createMutationRuntimeSnapshot,
  MUTATION_RUNTIME_ARTIFACTS,
  mutationRuntimeArtifactDigest,
  sealMutationRuntimeSnapshot,
} from "../audit/mutation-runtime-snapshot.ts";
import { validateMutationValidationTicketEvidence } from "../audit/mutation-ticket-evidence.ts";
import {
  createMutationValidationTicket,
  validateParentMutationValidationTicket,
  writeMutationValidationTicket,
} from "../audit/mutation-validation-ticket.ts";
import { digestWaveFiles, type MutationWaveManifest } from "../audit/mutation-wave.ts";
import type { PureTargetEntry } from "../audit/pure-targets.ts";

const roots: string[] = [];
const sha = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { patch?: boolean; qualityPolicy?: boolean; witness?: boolean } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "subkit-mutation-ticket-"));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(
    "package.json",
    options.patch
      ? '{"patchedDependencies":{"fixture":"patches/fixture.patch"}}\n'
      : '{"patchedDependencies":{}}\n',
  );
  if (options.patch) put("patches/fixture.patch", "fixture patch\n");
  for (const path of MUTATION_RUNTIME_ARTIFACTS) put(path, `fixture:${path}\n`);
  chmodSync(join(root, "dist/subkit"), 0o755);
  for (const path of mutationTestInputs(root)) if (path !== "package.json") put(path, "\n");
  const source = "export const target = true;\n";
  const testSource = 'import { target } from "./target.ts"; void target;\n';
  put("apps/engine/src/target.ts", source);
  put("apps/engine/src/target.test.ts", testSource);
  put("stryker.config.json", "{}\n");
  put("bun.lock", "lockfile\n");
  put("apps/engine/.mutation-equivalents.json", "{}\n");
  const ledgerPath = ".artifacts/ledger.json";
  if (options.witness) {
    const witnessRun = ".artifacts/goal-verification/runs/run-ticket-witness";
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const witnessDigest = digest(
      `apps/engine/src/target.ts\0${source}\0apps/engine/src/target.test.ts\0${testSource}\0`,
    );
    put(
      `${witnessRun}/runtime-witness.json`,
      `${JSON.stringify({ version: 1, status: "passed", exit_code: 0, source_digest: witnessDigest, command: "bun", args: ["test", "apps/engine/src/target.test.ts"] })}\n`,
    );
    put(
      `${witnessRun}/manifest.json`,
      `${JSON.stringify({ format: "subkit-verification-run", version: 1, status: "passed", resultPath: "result.json", sourceDigest: witnessDigest })}\n`,
    );
    put(
      `${witnessRun}/result.json`,
      `${JSON.stringify({ status: "passed", exitCode: 0, timedOut: false, command: "bun", args: ["test", "apps/engine/src/target.test.ts"] })}\n`,
    );
    put(
      ledgerPath,
      `${JSON.stringify({ version: 1, runtime_witnesses: [{ consumer: "apps/engine/src/target.ts", test: "apps/engine/src/target.test.ts", consumer_sha256: digest(source), test_sha256: digest(testSource), kind: "source-process", rationale: "fixture", independent_review: "fixture", execution_receipt_path: `${witnessRun}/runtime-witness.json`, execution_receipt_sha256: digest(readFileSync(join(root, `${witnessRun}/runtime-witness.json`), "utf8")) }] })}\n`,
    );
  } else put(ledgerPath, "{}\n");
  if (options.qualityPolicy) put("apps/engine/.quality-shard-policy.json", "{}\n");
  const runtimeInputs = mutationTestInputs(root);
  const runtimeArtifactDigest = mutationRuntimeArtifactDigest(root);
  const tests = ["apps/engine/src/target.test.ts"];
  const entry: PureTargetEntry = {
    path: "apps/engine/src/target.ts",
    owner_shard: "engine",
    subsystem: "engine",
    target_kind: "engine_core",
    eligibility: "eligible",
    source_of_inclusion: "isCorePath",
    public_facade_obligations: [],
    effect_ledger_status: "required",
    runtime_kind: "runtime",
  };
  const wave: MutationWaveManifest = {
    version: 1,
    wave_id: "ticket-fixture",
    source_freeze_sha256: digestWaveFiles(root, runtimeInputs),
    runtime_artifact_digest_sha256: runtimeArtifactDigest,
    test_freeze_sha256: digestWaveFiles(root, tests),
    target_digest_sha256: sha,
    config_sha256: digestWaveFiles(root, ["stryker.config.json"]),
    lock_sha256: digestWaveFiles(root, ["bun.lock"]),
    equivalence_manifest_path: "apps/engine/.mutation-equivalents.json",
    equivalence_manifest_sha256: digestWaveFiles(root, ["apps/engine/.mutation-equivalents.json"]),
    dynamic_import_ledger_path: ledgerPath,
    dynamic_import_ledger_sha256: digestWaveFiles(root, [ledgerPath]),
    ...(options.qualityPolicy
      ? {
          quality_policy_sha256: digestWaveFiles(root, ["apps/engine/.quality-shard-policy.json"]),
        }
      : {}),
    non_incremental: true,
    worker_budget: 1,
    shards: [
      {
        id: "engine",
        targets: [entry.path],
        tests: [
          { path: tests[0]!, kind: "direct", covers_targets: [entry.path], rationale: "fixture" },
        ],
        consumers: [],
        resource_tags: [],
      },
    ],
  };
  const run = join(root, ".reports/mutation/runs", wave.wave_id, "run-fixture");
  mkdirSync(run, { recursive: true });
  const manifestPath = join(run, "wave.json");
  const manifestText = `${JSON.stringify(wave)}\n`;
  writeFileSync(manifestPath, manifestText);
  const runtimeSnapshot = createMutationRuntimeSnapshot({
    repo: root,
    parentRunRoot: run,
    waveId: wave.wave_id,
    runId: "run-fixture",
    sourceFreezeSha256: wave.source_freeze_sha256,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    artifactDigestSha256: runtimeArtifactDigest,
  });
  const sealSha256 = sealMutationRuntimeSnapshot({
    path: runtimeSnapshot.path,
    sha256: runtimeSnapshot.sha256,
    expected: {
      wave_id: wave.wave_id,
      run_id: "run-fixture",
      source_freeze_sha256: wave.source_freeze_sha256,
      manifest_sha256: createHash("sha256").update(manifestText).digest("hex"),
      artifact_digest_sha256: runtimeArtifactDigest,
    },
  });
  const ticket = writeMutationValidationTicket({
    repo: root,
    parentRunRoot: run,
    copiedManifestPath: manifestPath,
    manifestText,
    wave,
    entries: [entry],
    runtimeInputs,
    closureFiles: mutationClosureFiles(root),
    runtimeSnapshot: { ...runtimeSnapshot, sealSha256 },
    runId: "run-fixture",
  });
  const sandbox = join(root, "sandbox");
  mkdirSync(sandbox);
  const env = {
    SUBKIT_MUTATION_PARENT_TICKET_PATH: ticket.path,
    SUBKIT_MUTATION_PARENT_TICKET_SHA256: ticket.sha256,
    SUBKIT_MUTATION_ORIGINAL_REPO: root,
  };
  return {
    root,
    put,
    wave,
    manifestPath,
    manifestText,
    run,
    entry,
    ticket,
    runtimeSnapshot: { ...runtimeSnapshot, sealSha256 },
    sandbox,
    env,
  };
}

test("valid parent ticket binds original bytes without reconstructing the AST closure", () => {
  const f = fixture();
  const validated = validateParentMutationValidationTicket({
    repo: f.root,
    manifestPath: f.manifestPath,
    shardId: "engine",
    sandboxRepo: f.sandbox,
    env: f.env,
  });
  expect(validated?.wave).toEqual(f.wave);
  expect(validated?.ticketSha256).toBe(f.ticket.sha256);
});

test("original repository alone preserves standalone full-validation fallback", () => {
  const f = fixture();
  expect(
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { SUBKIT_MUTATION_ORIGINAL_REPO: f.root },
    }),
  ).toBeNull();
});

test("forged, partial, and symlinked ticket inputs fail closed", () => {
  const f = fixture();
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { SUBKIT_MUTATION_PARENT_TICKET_PATH: f.ticket.path },
    }),
  ).toThrow("partial");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { ...f.env, SUBKIT_MUTATION_PARENT_TICKET_SHA256: sha },
    }),
  ).toThrow("sha256 differs");
  const link = join(f.root, "ticket-link.json");
  symlinkSync(f.ticket.path, link);
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { ...f.env, SUBKIT_MUTATION_PARENT_TICKET_PATH: link },
    }),
  ).toThrow("symlink");
});

test("source, test, and patch-provenance changes fail against the original repository", () => {
  for (const changed of [
    "apps/engine/src/target.ts",
    "apps/engine/src/target.test.ts",
    "package.json",
  ]) {
    const f = fixture();
    f.put(
      changed,
      changed === "package.json" ? '{"patchedDependencies":{},"changed":true}\n' : "changed\n",
    );
    expect(() =>
      validateParentMutationValidationTicket({
        repo: f.root,
        manifestPath: f.manifestPath,
        env: f.env,
      }),
    ).toThrow();
  }
});

test("a child fast path requires a sandbox distinct from the original repository", () => {
  const f = fixture();
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      sandboxRepo: f.root,
      env: f.env,
    }),
  ).toThrow("sandbox must differ");
});

test("new runtime and test files invalidate their exact respective inventories", () => {
  const runtime = fixture();
  runtime.put("apps/engine/src/new-runtime.ts", "export const added = true;\n");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: runtime.root,
      manifestPath: runtime.manifestPath,
      env: runtime.env,
    }),
  ).toThrow("runtime input inventory");

  const closure = fixture();
  closure.put("tests/new-closure.test.ts", "export {};\n");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: closure.root,
      manifestPath: closure.manifestPath,
      env: closure.env,
    }),
  ).toThrow("closure input inventory");
});

test("ticket issuance rejects bytes changed after parent validation and before ticket creation", () => {
  const f = fixture();
  f.put("apps/engine/src/target.ts", "export const target = false;\n");
  expect(() =>
    createMutationValidationTicket({
      repo: f.root,
      parentRunRoot: f.run,
      copiedManifestPath: f.manifestPath,
      manifestText: f.manifestText,
      wave: f.wave,
      entries: [f.entry],
      runtimeInputs: mutationTestInputs(f.root),
      closureFiles: mutationClosureFiles(f.root),
      runtimeSnapshot: f.runtimeSnapshot,
      runId: "run-fixture",
    }),
  ).toThrow("issuance freeze differs");
});

test("each non-source freeze binding rejects a post-ticket byte change", () => {
  for (const [path, reason, options] of [
    ["stryker.config.json", "config bytes", {}],
    ["bun.lock", "runtime source bytes", {}],
    ["apps/engine/.mutation-equivalents.json", "runtime source bytes", {}],
    [".artifacts/ledger.json", "runtime ledger is not valid JSON", {}],
    ["apps/engine/.quality-shard-policy.json", "runtime source bytes", { qualityPolicy: true }],
    ["patches/fixture.patch", "runtime source bytes", { patch: true }],
  ] as const) {
    const f = fixture(options);
    f.put(path, "changed\n");
    expect(() =>
      validateParentMutationValidationTicket({
        repo: f.root,
        manifestPath: f.manifestPath,
        env: f.env,
      }),
    ).toThrow(reason);
  }
});

test("copied manifest changes to target, test, consumer, or resource fields reject before dispatch", () => {
  const altered = {
    targets: (wave: MutationWaveManifest): MutationWaveManifest => ({
      ...wave,
      shards: [{ ...wave.shards[0]!, targets: [] }],
    }),
    tests: (wave: MutationWaveManifest): MutationWaveManifest => ({
      ...wave,
      shards: [{ ...wave.shards[0]!, tests: [] }],
    }),
    consumers: (wave: MutationWaveManifest): MutationWaveManifest => ({
      ...wave,
      shards: [
        {
          ...wave.shards[0]!,
          consumers: [{ path: "apps/engine/src/consumer.ts", witnesses: [] }],
        },
      ],
    }),
    resource_tags: (wave: MutationWaveManifest): MutationWaveManifest => ({
      ...wave,
      shards: [{ ...wave.shards[0]!, resource_tags: ["db"] }],
    }),
  };
  for (const rewrite of Object.values(altered)) {
    const f = fixture();
    writeFileSync(f.manifestPath, `${JSON.stringify(rewrite(f.wave))}\n`);
    expect(() =>
      validateParentMutationValidationTicket({
        repo: f.root,
        manifestPath: f.manifestPath,
        env: f.env,
      }),
    ).toThrow("manifest bytes");
  }
});

test("ticket path parent symlinks, directories, wrong originals, and unknown shards fail closed", () => {
  const f = fixture();
  const linkedParent = join(f.root, "linked-run");
  symlinkSync(f.run, linkedParent);
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: {
        ...f.env,
        SUBKIT_MUTATION_PARENT_TICKET_PATH: join(linkedParent, "mutation-validation-ticket.json"),
      },
    }),
  ).toThrow("symlink");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { ...f.env, SUBKIT_MUTATION_PARENT_TICKET_PATH: f.run },
    }),
  ).toThrow("regular");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: { ...f.env, SUBKIT_MUTATION_ORIGINAL_REPO: f.sandbox },
    }),
  ).toThrow("original repository differs");
  expect(() =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      shardId: "other",
      env: f.env,
    }),
  ).toThrow("selected shard differs");
});

test("linked runtime-witness manifest and result bytes are revalidated after ticket issuance", () => {
  for (const file of ["manifest.json", "result.json"]) {
    const f = fixture({ witness: true });
    const proof = {
      repo: f.root,
      wave: f.wave,
      waveText: f.manifestText,
      runId: "run-fixture",
      mutationRoot: relative(f.root, f.run),
      ticketPath: relative(f.root, f.ticket.path),
      ticketSha256: f.ticket.sha256,
      ticketText: f.ticket.text,
    };
    expect(() => validateMutationValidationTicketEvidence(proof)).not.toThrow();
    expect(() =>
      validateParentMutationValidationTicket({
        repo: f.root,
        manifestPath: f.manifestPath,
        env: f.env,
      }),
    ).not.toThrow();
    f.put(`.artifacts/goal-verification/runs/run-ticket-witness/${file}`, "{}\n");
    expect(() => validateMutationValidationTicketEvidence(proof)).toThrow(
      "runtime witness differs",
    );
    expect(() =>
      validateParentMutationValidationTicket({
        repo: f.root,
        manifestPath: f.manifestPath,
        env: f.env,
      }),
    ).toThrow("runtime witness differs");
  }
});

test("a repeated child validation reuses the file stamp only while every bound file is untouched", () => {
  const f = fixture();
  const validate = () =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      shardId: "engine",
      sandboxRepo: f.sandbox,
      env: f.env,
      reuseFileStamp: true,
    });
  expect(validate()?.reusedFileStamp).toBe(false);
  expect(validate()?.reusedFileStamp).toBe(true);
  expect(
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: f.env,
    })?.reusedFileStamp,
  ).toBe(false);
  for (const changed of ["apps/engine/src/target.ts", "apps/engine/src/target.test.ts"]) {
    const g = fixture();
    const again = () =>
      validateParentMutationValidationTicket({
        repo: g.root,
        manifestPath: g.manifestPath,
        env: g.env,
        reuseFileStamp: true,
      });
    expect(again()?.reusedFileStamp).toBe(false);
    expect(again()?.reusedFileStamp).toBe(true);
    const before = statSync(join(g.root, changed));
    const original = readFileSync(join(g.root, changed), "utf8");
    writeFileSync(join(g.root, changed), original.replace("target", "tarbet"));
    utimesSync(join(g.root, changed), before.atime, before.mtime);
    expect(statSync(join(g.root, changed)).size).toBe(before.size);
    expect(again).toThrow("bytes differs");
  }
});

test("a file stamp for another ticket or with a forged state forces the full byte validation", () => {
  const f = fixture();
  const validate = () =>
    validateParentMutationValidationTicket({
      repo: f.root,
      manifestPath: f.manifestPath,
      env: f.env,
      reuseFileStamp: true,
    });
  expect(validate()?.reusedFileStamp).toBe(false);
  const stamp = join(f.run, "validation-stamps", `${f.ticket.sha256}.json`);
  const recorded = JSON.parse(readFileSync(stamp, "utf8"));
  writeFileSync(stamp, `${JSON.stringify({ ...recorded, ticket_sha256: sha })}\n`);
  expect(validate()?.reusedFileStamp).toBe(false);
  expect(validate()?.reusedFileStamp).toBe(true);
  writeFileSync(stamp, `${JSON.stringify({ ...recorded, file_state_sha256: sha })}\n`);
  expect(validate()?.reusedFileStamp).toBe(false);
  writeFileSync(stamp, "not json\n");
  expect(validate()?.reusedFileStamp).toBe(false);
  expect(JSON.parse(readFileSync(stamp, "utf8"))).toEqual(recorded);
});
