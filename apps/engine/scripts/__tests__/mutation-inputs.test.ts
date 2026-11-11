import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestFiles,
  mutationTestInputs,
  patchedDependencyInputs,
} from "../audit/mutation-inputs.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "subkit-mutation-patches-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "patches"));
  return root;
}

function writeManifest(root: string, patchedDependencies: unknown): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ patchedDependencies }));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mutation runtime provenance inputs", () => {
  test("includes transitive helpers, Bun preloads, configuration, tests and JSON fixtures", () => {
    const inputs = mutationTestInputs(REPO);
    expect(inputs).toEqual(
      expect.arrayContaining([
        "apps/engine/src/workflows/stored-spec.ts",
        "apps/engine/src/tests/setup-deterministic-env.ts",
        "apps/sk/src/tests/setup-isolated-home.ts",
        "apps/engine/src/workflows/draft-projection.test.ts",
        "apps/engine/src/workflows/tests/fixtures/br-test-603.json",
        "apps/engine/.mutation-equivalents.json",
        "apps/engine/scripts/audit/distributed-quality-artifacts.ts",
        "apps/engine/scripts/audit/distributed-quality-budget.ts",
        "apps/engine/scripts/audit/distributed-quality-ticket.ts",
        "apps/engine/scripts/audit/quality-wave-manifest.ts",
        "apps/engine/scripts/__tests__/native-exact-ignored-mutants.test.ts",
        "apps/engine/scripts/distributed-quality.ts",
        "apps/engine/scripts/prepare-distributed-quality-ticket.ts",
        "apps/engine/scripts/validate-distributed-quality-executor.ts",
        "apps/engine/scripts/audit/files.ts",
        "apps/engine/scripts/audit/mutation-floor.ts",
        "apps/engine/scripts/audit/mutation-infrastructure-sentinel.ts",
        "apps/engine/scripts/audit/mutation-shard-score.ts",
        "apps/engine/scripts/audit/mutation-scope.ts",
        "apps/engine/scripts/audit/mutation-wave.ts",
        "apps/engine/scripts/audit/mutation-closure.ts",
        "apps/engine/scripts/audit/pure-targets.ts",
        "apps/engine/scripts/audit/ratchets.ts",
        "apps/engine/scripts/audit/transitive-purity.ts",
        "apps/engine/scripts/audit/rules.ts",
        "scripts/lib/bounded-output-log.ts",
        "apps/engine/scripts/check-mutation-floor.ts",
        "apps/engine/scripts/prepare-mutation-run.ts",
        "apps/engine/scripts/prepare-mutation-shards.ts",
        "apps/engine/scripts/run-coverage-shards.ts",
        "apps/engine/scripts/verify-quality-shards.ts",
        "apps/engine/scripts/check-coverage-floor.ts",
        "apps/engine/scripts/audit/coverage-union.ts",
        "apps/engine/scripts/audit/coverage-artifacts.ts",
        "apps/engine/scripts/audit/coverage-shard-plan.ts",
        "apps/engine/scripts/audit/coverage-environment.ts",
        "apps/engine/.coverage-floor.json",
        "packages/chat-ui/src/ScrollView.tsx",
        "bunfig.toml",
        "bun.lock",
        "tsconfig.json",
        "tsconfig.base.json",
        "patches/@stryker-mutator%2Finstrumenter@10.1.1.patch",
        "patches/@stryker-mutator%2Fapi@10.1.1.patch",
      ]),
    );
  });

  test("binds every declared regular patch file and rejects unbound or symlink patch bytes", () => {
    const root = fixtureRoot();
    const patches = join(root, "patches");
    writeManifest(root, { "example@1.0.0": "patches/example.patch" });
    writeFileSync(join(patches, "example.patch"), "diff --git a/a b/a\n");
    expect(patchedDependencyInputs(root)).toEqual(["patches/example.patch"]);

    writeFileSync(join(patches, "unbound.patch"), "diff --git a/b b/b\n");
    expect(() => patchedDependencyInputs(root)).toThrow("unbound patch files");
  });

  test("refuses a declared patch symlink even when its target is inside the repository", () => {
    const root = fixtureRoot();
    const patches = join(root, "patches");
    writeFileSync(join(patches, "target.patch"), "diff --git a/a b/a\n");
    symlinkSync("target.patch", join(patches, "example.patch"));
    writeManifest(root, { "example@1.0.0": "patches/example.patch" });
    expect(() => patchedDependencyInputs(root)).toThrow("must not traverse a symlink");
  });

  test("rejects missing, escaping and invalid patch declarations", () => {
    const missing = fixtureRoot();
    writeManifest(missing, { "example@1.0.0": "patches/missing.patch" });
    expect(() => patchedDependencyInputs(missing)).toThrow("patch is missing");

    const escaping = fixtureRoot();
    writeManifest(escaping, { "example@1.0.0": "../outside.patch" });
    expect(() => patchedDependencyInputs(escaping)).toThrow("escapes the repository");

    const invalid = fixtureRoot();
    writeManifest(invalid, []);
    expect(() => patchedDependencyInputs(invalid)).toThrow("must be an object");

    const nullValue = fixtureRoot();
    writeManifest(nullValue, null);
    expect(() => patchedDependencyInputs(nullValue)).toThrow("must be an object");
  });

  test("rejects an unbound patch even without a patchedDependencies field", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "patches", "orphan.patch"), "diff --git a/a b/a\n");
    expect(() => patchedDependencyInputs(root)).toThrow("unbound patch files");
  });

  test("includes patch bytes in the freeze digest", () => {
    const root = fixtureRoot();
    const patch = join(root, "patches", "example.patch");
    writeManifest(root, { "example@1.0.0": "patches/example.patch" });
    writeFileSync(patch, "diff --git a/a b/a\n");
    const digest = (parts: readonly (string | Uint8Array)[]) =>
      createHash("sha256")
        .update(
          Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part))),
        )
        .digest("hex");
    const before = digestFiles(root, patchedDependencyInputs(root), digest);
    writeFileSync(patch, "diff --git a/a b/a\n+patched\n");
    expect(digestFiles(root, patchedDependencyInputs(root), digest)).not.toBe(before);
  });

  test("binds quality wave manifest factory bytes into a freeze digest", () => {
    const root = fixtureRoot();
    writeManifest(root, {});
    const path = "apps/engine/scripts/audit/quality-wave-manifest.ts";
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "export const manifest = 1;\n");
    const digest = (parts: readonly (string | Uint8Array)[]) =>
      createHash("sha256")
        .update(
          Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part))),
        )
        .digest("hex");
    const selected = mutationTestInputs(root).filter((input) => input === path);
    expect(selected).toEqual([path]);
    const before = digestFiles(root, selected, digest);
    writeFileSync(join(root, path), "export const manifest = 2;\n");
    expect(digestFiles(root, selected, digest)).not.toBe(before);
  });
});
