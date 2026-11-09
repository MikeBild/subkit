import { describe, expect, test } from "bun:test";
import {
  digestCanonical,
  readValidatedWaveManifest,
  validateMutationWaveManifest,
} from "../audit/mutation-wave.ts";

const hash = "a".repeat(64);
const targets = ["apps/engine/src/x/core.ts", "packages/shared/src/pure.ts"];
const files = [...targets, "apps/engine/src/x/core.test.ts", "apps/engine/src/x/consumer.ts"];

const manifest = () => ({
  version: 1 as const,
  wave_id: "p1-test",
  source_freeze_sha256: hash,
  test_freeze_sha256: hash,
  target_digest_sha256: digestCanonical(targets),
  config_sha256: hash,
  lock_sha256: hash,
  equivalence_manifest_sha256: hash,
  dynamic_import_ledger_sha256: hash,
  equivalence_manifest_path: "apps/engine/.mutation-equivalents.json",
  dynamic_import_ledger_path: "apps/engine/.dynamic-import-ledger.json",
  non_incremental: true as const,
  worker_budget: 2,
  shards: [
    {
      id: "engine-x",
      targets: [targets[0]!],
      tests: [
        {
          path: "apps/engine/src/x/core.test.ts",
          kind: "direct" as const,
          covers_targets: [targets[0]!],
          rationale: "direct",
        },
      ],
      consumers: [
        { path: "apps/engine/src/x/consumer.ts", witnesses: ["apps/engine/src/x/core.test.ts"] },
      ],
      resource_tags: ["cpu"],
    },
    {
      id: "shared",
      targets: [targets[1]!],
      tests: [
        {
          path: "apps/engine/src/x/core.test.ts",
          kind: "direct" as const,
          covers_targets: [targets[1]!],
          rationale: "shared witness",
        },
      ],
      consumers: [],
      resource_tags: ["cpu"],
    },
  ],
});

describe("mutation wave manifest", () => {
  test("accepts a complete disjoint reviewed partition", () => {
    expect(
      validateMutationWaveManifest({
        manifest: manifest(),
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }),
    ).toEqual([]);
  });

  test("records a type-only target in the canonical partition without inventing a test", () => {
    const value = manifest();
    value.shards[1]!.tests = [];
    expect(
      validateMutationWaveManifest({
        manifest: value,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
        type_only_targets: [targets[1]!],
      }),
    ).toEqual([]);
  });

  test("rejects malformed and stale target metadata at the read boundary", () => {
    expect(() =>
      readValidatedWaveManifest({
        text: "{",
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }),
    ).toThrow("not valid JSON");
    const stale = { ...manifest(), target_digest_sha256: "b".repeat(64) };
    expect(() =>
      readValidatedWaveManifest({
        text: JSON.stringify(stale),
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }),
    ).toThrow("target digest differs");
  });

  test("fails closed when the canonical Docker acceptance inventory is omitted or misclassified", () => {
    const docker = "tests/docker/bootstrap.docker.test.ts";
    const value = manifest();
    value.shards[0]!.tests.push({
      path: docker,
      kind: "reverse_import",
      covers_targets: [targets[0]!],
      rationale: "compiled image acceptance",
      execution: "in_process",
    });
    const input = {
      manifest: value,
      canonical_targets: targets,
      canonical_target_digest: digestCanonical(targets),
      known_files: [...files, docker],
    };
    expect(validateMutationWaveManifest(input).join("\n")).toContain("external runtime");
    value.external_runtime_tests = [docker];
    value.shards[0]!.tests.at(-1)!.execution = "external_runtime";
    expect(validateMutationWaveManifest(input)).toEqual([]);
  });

  test("fails closed for duplicate, missing, extra, escape and incomplete consumer closure", () => {
    const duplicate = manifest();
    duplicate.shards[1]!.targets = [targets[0]!];
    expect(
      validateMutationWaveManifest({
        manifest: duplicate,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }).join("\n"),
    ).toContain("multiple owners");

    const missing = manifest();
    missing.shards[1]!.targets = [];
    expect(
      validateMutationWaveManifest({
        manifest: missing,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }).join("\n"),
    ).toContain("no owner");

    const escapingManifest = manifest();
    escapingManifest.shards[1]!.targets = ["../escape.ts"];
    expect(
      validateMutationWaveManifest({
        manifest: escapingManifest,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }).join("\n"),
    ).toContain("non-canonical");

    const closure = manifest();
    closure.shards[0]!.consumers = [{ path: "apps/engine/src/x/consumer.ts", witnesses: [] }];
    expect(
      validateMutationWaveManifest({
        manifest: closure,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }).join("\n"),
    ).toContain("no witness");

    const foreign = manifest();
    foreign.shards[1]!.tests[0]!.covers_targets = [targets[0]!];
    expect(
      validateMutationWaveManifest({
        manifest: foreign,
        canonical_targets: targets,
        canonical_target_digest: digestCanonical(targets),
        known_files: files,
      }).join("\n"),
    ).toContain("foreign target");
  });
});
