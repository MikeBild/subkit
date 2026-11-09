import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mutationTestInputs } from "../audit/mutation-inputs.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

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
        "apps/engine/scripts/audit/files.ts",
        "apps/engine/scripts/audit/mutation-floor.ts",
        "apps/engine/scripts/audit/mutation-scope.ts",
        "apps/engine/scripts/audit/mutation-wave.ts",
        "apps/engine/scripts/audit/mutation-closure.ts",
        "apps/engine/scripts/audit/pure-targets.ts",
        "apps/engine/scripts/audit/ratchets.ts",
        "apps/engine/scripts/audit/transitive-purity.ts",
        "apps/engine/scripts/audit/rules.ts",
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
      ]),
    );
  });
});
