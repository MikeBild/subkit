import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildMutationShardConfig } from "../audit/mutation-shard-config.ts";
import { validateMutationShardUnion } from "../audit/mutation-union.ts";
import type { MutationWaveManifest } from "../audit/mutation-wave.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = "a".repeat(64);
const target = "apps/engine/src/workflows/core/workflow.ts";
const source = "export const workflow = 'fixture';\n";
const shard = {
  id: "core",
  targets: [target],
  tests: [
    {
      path: "apps/engine/src/workflows/core/workflow.test.ts",
      kind: "direct" as const,
      covers_targets: [target],
      rationale: "fixture",
    },
  ],
  consumers: [],
  resource_tags: [],
};
const wave: MutationWaveManifest = {
  version: 1,
  wave_id: "wave",
  source_freeze_sha256: token,
  test_freeze_sha256: token,
  target_digest_sha256: token,
  config_sha256: token,
  lock_sha256: token,
  equivalence_manifest_sha256: token,
  dynamic_import_ledger_sha256: token,
  dynamic_import_ledger_path: "ledger.json",
  equivalence_manifest_path: "equiv.json",
  non_incremental: true,
  worker_budget: 1,
  shards: [shard],
};
const base = {
  testRunner: "command",
  commandRunner: { command: "bun run apps/engine/scripts/run-core-tests.ts" },
  coverageAnalysis: "off",
  mutate: [target],
  incremental: false,
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
};
function input() {
  const config = buildMutationShardConfig({
    base,
    waveId: "wave",
    runId: "run",
    manifestPath: "/tmp/wave.json",
    shard,
    workers: 1,
  });
  const report = { config, files: { [target]: { source, mutants: [{ status: "Killed" }] } } };
  const reportText = JSON.stringify(report);
  const receipt = {
    version: 1,
    wave_id: "wave",
    run_id: "run",
    shard_id: "core",
    manifest_sha256: token,
    config_sha256: sha(JSON.stringify(config)),
    base_config_sha256: token,
    report_sha256: sha(reportText),
    source_sha256: token,
    test_sha256: token,
    target_digest_sha256: token,
    canonical_target_sha256: token,
    lock_sha256: token,
    equivalence_manifest_sha256: token,
    dynamic_import_ledger_sha256: token,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
    exit_code: 0,
    targets: [target],
    workers: 1,
  };
  return {
    wave,
    runId: "run",
    manifestPath: "/tmp/wave.json",
    baseConfig: base,
    canonicalScope: [target],
    sourceSha256: token,
    testSha256: token,
    workersByShard: { core: 1 },
    shards: [
      {
        id: "core",
        receiptText: JSON.stringify(receipt),
        configText: JSON.stringify(config),
        reportText,
        exitCode: 0,
      },
    ],
    manifestSha256: token,
    equivalenceManifest: { version: 1, equivalents: [] },
    repo: process.cwd(),
    sourceSha256ForFile: () => sha(source),
  };
}

type JsonRecord = Record<string, unknown>;
const reportFiles = (report: JsonRecord): JsonRecord => report.files as JsonRecord;
const reportTarget = (report: JsonRecord): JsonRecord => reportFiles(report)[target] as JsonRecord;
const reportConfig = (report: JsonRecord): JsonRecord => report.config as JsonRecord;
describe("mutation shard union", () => {
  test("accepts an exact full union", () =>
    expect(validateMutationShardUnion(input())).toEqual([]));
  test("bounds reported deadline kills by the killed mutants of the shard", () => {
    for (const [deadline_kills, valid] of [
      [0, true],
      [1, true],
      [2, false],
      [-1, false],
      [0.5, false],
      ["1", false],
    ] as const) {
      const value = input();
      const receipt = JSON.parse(value.shards[0]!.receiptText);
      value.shards[0]!.receiptText = JSON.stringify({ ...receipt, deadline_kills });
      expect(validateMutationShardUnion(value)).toEqual(
        valid ? [] : ["shard core receipt deadline kills invalid"],
      );
    }
  });
  test("keeps a type-only target in the receipt while excluding it from mutation evidence", () => {
    const value = input();
    const typeOnly = "apps/engine/src/self-healing/core/patch-proposal.ts";
    const typeOnlyShard = { ...shard, targets: [target, typeOnly] };
    value.wave = { ...wave, shards: [typeOnlyShard] };
    value.canonicalScope = [target, typeOnly];
    value.runtimeScope = [target];
    const receipt = JSON.parse(value.shards[0]!.receiptText);
    receipt.targets = [target, typeOnly];
    receipt.runtime_targets = [target];
    receipt.type_only_targets = [typeOnly];
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value)).toEqual([]);
  });
  test("accepts a terminal no-tool receipt for an all-type-only shard", () => {
    const value = input();
    const typeOnly = "apps/engine/src/self-healing/core/patch-proposal.ts";
    const typeOnlyShard = { ...shard, targets: [typeOnly], tests: [] };
    value.wave = { ...wave, shards: [typeOnlyShard] };
    value.canonicalScope = [typeOnly];
    value.runtimeScope = [];
    const receipt = JSON.parse(value.shards[0]!.receiptText);
    Object.assign(receipt, {
      targets: [typeOnly],
      runtime_targets: [],
      type_only_targets: [typeOnly],
      not_applicable: "type_only_ast",
      config_sha256: "",
      report_sha256: "",
    });
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    value.shards[0]!.configText = "";
    value.shards[0]!.reportText = "";
    expect(validateMutationShardUnion(value)).toEqual([]);
  });
  test("rejects missing duplicate and extra shards or targets", () => {
    const missing = input();
    missing.shards = [];
    expect(validateMutationShardUnion(missing).join("\n")).toContain("missing shard result");
    const duplicate = input();
    duplicate.shards = [...duplicate.shards, duplicate.shards[0]!];
    expect(validateMutationShardUnion(duplicate).join("\n")).toContain("duplicate shard result");
    const extra = input();
    extra.shards = [...extra.shards, { ...extra.shards[0]!, id: "extra" }];
    expect(validateMutationShardUnion(extra).join("\n")).toContain("extra shard result");
  });
  test("rejects stale receipt digests and report hash", () => {
    for (const key of [
      "source_sha256",
      "test_sha256",
      "config_sha256",
      "lock_sha256",
      "equivalence_manifest_sha256",
      "dynamic_import_ledger_sha256",
      "report_sha256",
    ] as const) {
      const value = input();
      const receipt = JSON.parse(value.shards[0]!.receiptText);
      receipt[key] = "b".repeat(64);
      value.shards[0]!.receiptText = JSON.stringify(receipt);
      expect(validateMutationShardUnion(value).length).toBeGreaterThan(0);
    }
  });
  test("rejects partial or noncanonical parent validation ticket bindings", () => {
    for (const binding of [
      { parent_validation_ticket_path: "reports/mutation-ticket.json" },
      { parent_validation_ticket_sha256: token },
      {
        parent_validation_ticket_path: "../mutation-validation-ticket.json",
        parent_validation_ticket_sha256: token,
      },
      {
        parent_validation_ticket_path: "reports/mutation-ticket.json",
        parent_validation_ticket_sha256: "bad",
      },
    ]) {
      const value = input();
      const receipt = JSON.parse(value.shards[0]!.receiptText);
      Object.assign(receipt, binding);
      value.shards[0]!.receiptText = JSON.stringify(receipt);
      expect(validateMutationShardUnion(value).join("\n")).toContain(
        "parent validation ticket binding",
      );
    }
  });
  test("rejects changed native exact-ignore config even when report hashes are refreshed", () => {
    const value = input();
    const report = JSON.parse(value.shards[0]!.reportText);
    report.config.mutator = { exactIgnoredMutants: [{ file: "foreign.ts" }] };
    value.shards[0]!.reportText = JSON.stringify(report);
    const receipt = JSON.parse(value.shards[0]!.receiptText);
    receipt.report_sha256 = sha(value.shards[0]!.reportText);
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value).join("\n")).toContain(
      "report config exactIgnoredMutants mismatch",
    );
  });
  test("rejects weakened config, command mismatch, nonterminal, ignored and zero mutants", () => {
    const mutateConfig = (report: JsonRecord, change: (config: JsonRecord) => void) =>
      change(reportConfig(report));
    const mutations: Array<(report: JsonRecord) => void> = [
      (report) =>
        mutateConfig(report, (config) => {
          config.incremental = true;
        }),
      (report) =>
        mutateConfig(report, (config) => {
          (config.thresholds as JsonRecord).break = 0;
        }),
      (report) =>
        mutateConfig(report, (config) => {
          (config.commandRunner as JsonRecord).command = "bad";
        }),
      (report) => {
        report.errors = [{ message: "bad" }];
      },
      (report) => {
        reportTarget(report).mutants = [{ status: "Ignored" }];
      },
      (report) => {
        reportTarget(report).mutants = [];
      },
    ];
    for (const mutate of mutations) {
      const value = input();
      const report = JSON.parse(value.shards[0]!.reportText) as JsonRecord;
      mutate(report);
      value.shards[0]!.reportText = JSON.stringify(report);
      expect(validateMutationShardUnion(value).length).toBeGreaterThan(0);
    }
  });
  test("rejects malformed report files, backward receipts and forged config exclusions", () => {
    const changes: Array<(report: JsonRecord) => void> = [
      (report) => {
        reportFiles(report)[target] = null;
      },
      (report) => {
        reportTarget(report).mutants = null;
      },
      (report) => {
        reportConfig(report).ignoreStatic = true;
      },
      (report) => {
        reportConfig(report).mutator = { excludedMutations: ["BooleanLiteral"] };
      },
    ];
    for (const change of changes) {
      const value = input();
      const report = JSON.parse(value.shards[0]!.reportText) as JsonRecord;
      change(report);
      value.shards[0]!.reportText = JSON.stringify(report);
      const receipt = JSON.parse(value.shards[0]!.receiptText) as JsonRecord;
      receipt.report_sha256 = sha(value.shards[0]!.reportText);
      value.shards[0]!.receiptText = JSON.stringify(receipt);
      expect(validateMutationShardUnion(value).length).toBeGreaterThan(0);
    }
    const value = input();
    const receipt = JSON.parse(value.shards[0]!.receiptText);
    receipt.finished_at = "2025-01-01T00:00:00.000Z";
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value).join("\n")).toContain("terminal metadata");
  });
  test("rejects a report source that differs from the frozen target even with a refreshed report receipt", () => {
    const value = input();
    const report = JSON.parse(value.shards[0]!.reportText) as JsonRecord;
    reportTarget(report).source = "export const workflow = 'stale';\n";
    value.shards[0]!.reportText = JSON.stringify(report);
    const receipt = JSON.parse(value.shards[0]!.receiptText) as JsonRecord;
    receipt.report_sha256 = sha(value.shards[0]!.reportText);
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value).join("\n")).toContain("report target source mismatch");
  });
  test("rejects an ordinary report target without source bytes", () => {
    const value = input();
    const report = JSON.parse(value.shards[0]!.reportText) as JsonRecord;
    delete reportTarget(report).source;
    value.shards[0]!.reportText = JSON.stringify(report);
    const receipt = JSON.parse(value.shards[0]!.receiptText) as JsonRecord;
    receipt.report_sha256 = sha(value.shards[0]!.reportText);
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value).join("\n")).toContain("report target has no source");
  });
  test("accepts explicit safe Stryker defaults injected into a report config", () => {
    const value = input();
    const report = JSON.parse(value.shards[0]!.reportText);
    report.config.ignoreStatic = false;
    report.config.mutator = { excludedMutations: [] };
    value.shards[0]!.reportText = JSON.stringify(report);
    const receipt = JSON.parse(value.shards[0]!.receiptText);
    receipt.report_sha256 = sha(value.shards[0]!.reportText);
    value.shards[0]!.receiptText = JSON.stringify(receipt);
    expect(validateMutationShardUnion(value)).toEqual([]);
  });
  test("accepts reviewed ignored mutants across two owner shards", () => {
    const source = "before\n{\n  return null;\n}\nafter\n";
    const location = { start: { line: 2, column: 1 }, end: { line: 4, column: 2 } };
    const files = ["apps/engine/src/example/core-a.ts", "apps/engine/src/example/core-b.ts"];
    const shards = files.map((file, index) => ({
      id: `s${index}`,
      targets: [file],
      tests: [
        {
          path: `apps/engine/src/example/core-${index}.test.ts`,
          kind: "direct" as const,
          covers_targets: [file],
          rationale: "fixture",
        },
      ],
      consumers: [],
      resource_tags: [],
    }));
    const twoWave = { ...wave, shards };
    const equivalents = {
      version: 1 as const,
      equivalents: files.map((file) => ({
        file,
        source_sha256: sha(source),
        location,
        mutatorName: "BlockStatement",
        replacement: "{}",
        original: "{\n  return null;\n}",
        statusReason: "reviewed equivalent",
        reason: "Equivalent fixture",
        independent_review: "Independent fixture review",
      })),
    };
    const results = shards.map((shard) => {
      const config = buildMutationShardConfig({
        base,
        waveId: "wave",
        runId: "run",
        manifestPath: "/tmp/wave.json",
        shard,
        workers: 1,
        exactIgnoredMutants: equivalents.equivalents
          .filter((entry) => shard.targets.includes(entry.file))
          .map(({ reason, independent_review, ...entry }) => entry),
      });
      const reportText = JSON.stringify({
        config,
        files: {
          [shard.targets[0]!]: {
            source,
            mutants: [
              {
                status: "Ignored",
                mutatorName: "BlockStatement",
                replacement: "{}",
                statusReason: "reviewed equivalent",
                location,
              },
            ],
          },
        },
      });
      const receipt = {
        version: 1,
        wave_id: "wave",
        run_id: "run",
        shard_id: shard.id,
        manifest_sha256: token,
        config_sha256: sha(JSON.stringify(config)),
        base_config_sha256: token,
        report_sha256: sha(reportText),
        source_sha256: token,
        test_sha256: token,
        target_digest_sha256: token,
        canonical_target_sha256: token,
        lock_sha256: token,
        equivalence_manifest_sha256: token,
        dynamic_import_ledger_sha256: token,
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z",
        exit_code: 0,
        targets: shard.targets,
        workers: 1,
      };
      return {
        id: shard.id,
        receiptText: JSON.stringify(receipt),
        configText: JSON.stringify(config),
        reportText,
        exitCode: 0,
      };
    });
    const value = {
      ...input(),
      wave: twoWave,
      canonicalScope: files,
      workersByShard: { s0: 1, s1: 1 },
      shards: results,
      equivalenceManifest: equivalents,
      sourceSha256ForFile: () => sha(source),
    };
    expect(validateMutationShardUnion(value)).toEqual([]);
    for (const changed of ["configText", "reportText"] as const) {
      const altered = { ...value, shards: structuredClone(value.shards) };
      const shard = altered.shards[0]!;
      const document = JSON.parse(shard[changed]);
      const configuration = changed === "configText" ? document : document.config;
      configuration.mutator.exactIgnoredMutants = [];
      shard[changed] = JSON.stringify(document);
      const receipt = JSON.parse(shard.receiptText);
      receipt[changed === "configText" ? "config_sha256" : "report_sha256"] = sha(shard[changed]);
      shard.receiptText = JSON.stringify(receipt);
      expect(validateMutationShardUnion(altered).join("\n")).toContain(
        "exactIgnoredMutants mismatch",
      );
    }
    const partial = {
      ...value,
      equivalenceManifest: {
        ...equivalents,
        equivalents: [
          ...equivalents.equivalents,
          {
            ...equivalents.equivalents[0]!,
            mutatorName: "ConditionalExpression",
            replacement: "false",
          },
        ],
      },
    };
    expect(validateMutationShardUnion(partial).join("\n")).toContain(
      "config exactIgnoredMutants mismatch",
    );
  });
});
