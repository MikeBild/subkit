import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listFiles } from "./files.ts";

const RUNTIME_ROOTS = ["apps/cockpit/src", "apps/engine/src", "apps/sk/src", "packages"];
const RUNTIME_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|wat)$/;
export function mutationClosureFiles(repo: string): string[] {
  return [...RUNTIME_ROOTS, "tests"]
    .flatMap((root) =>
      listFiles(join(repo, root), (file) => /\.tsx?$/.test(file)).map((file) =>
        relative(repo, file),
      ),
    )
    .sort();
}
const RUNNER_INPUTS = [
  "apps/engine/.quality-shard-policy.json",
  "apps/engine/scripts/audit/quality-shard-policy.ts",
  "apps/engine/scripts/audit/quality-runtime-witness-policy.ts",
  "apps/engine/scripts/record-quality-runtime-witnesses.ts",
  "apps/engine/scripts/generate-quality-wave.ts",
  "apps/engine/scripts/verify-quality-release-shards.ts",
  "apps/engine/scripts/run-external-runtime-acceptance.ts",
  "scripts/export-shard-quality-evidence.ts",
  "scripts/verify-shard-quality-bundle.ts",
  ".github/workflows/quality.yml",
  ".github/workflows/release.yml",
  "apps/engine/scripts/run-mutation-shards.ts",
  "apps/engine/scripts/run-coverage-shards.ts",
  "apps/engine/scripts/verify-quality-shards.ts",
  "apps/engine/scripts/audit/mutation-scheduler.ts",
  "apps/engine/scripts/audit/mutation-shard-config.ts",
  "apps/engine/scripts/audit/mutation-union.ts",
  "apps/engine/scripts/audit/mutation-shard-score.ts",
  "apps/engine/scripts/audit/coverage-union.ts",
  "apps/engine/scripts/audit/coverage-artifacts.ts",
  "apps/engine/scripts/audit/coverage-publication.ts",
  "apps/engine/scripts/audit/coverage-retention.ts",
  "apps/engine/scripts/audit/coverage-floor.ts",
  "apps/engine/scripts/audit/coverage-shard-plan.ts",
  "apps/engine/scripts/audit/external-runtime-tests.ts",
  "apps/engine/scripts/audit/coverage-environment.ts",
  "apps/engine/scripts/audit/bounded-runner.ts",
  "apps/engine/scripts/audit/lcov.ts",
  "scripts/run-with-verification-log.ts",
  "scripts/lib/verification-run-lifecycle.ts",
  "scripts/lib/owned-process-watchdog.ts",
  "scripts/lib/local-database-url.ts",
  "scripts/lib/source-digest.ts",
  "scripts/test-docker-isolated.ts",
  "Dockerfile",
  "tests/docker/_run.ts",
  "tests/docker/_harness.ts",
  "tests/docker/_finalize-seeds.ts",
  "docker-compose.test.yml",
  "apps/engine/scripts/run-core-tests.ts",
  "apps/engine/scripts/audit/core-tests.ts",
  "apps/engine/scripts/audit/files.ts",
  "apps/engine/scripts/audit/mutation-floor.ts",
  "apps/engine/scripts/audit/mutation-inputs.ts",
  "apps/engine/scripts/audit/mutation-scope.ts",
  "apps/engine/scripts/audit/mutation-wave.ts",
  "apps/engine/scripts/audit/mutation-closure.ts",
  "apps/engine/scripts/audit/runtime-witnesses.ts",
  "apps/engine/scripts/audit/pure-targets.ts",
  "apps/engine/scripts/audit/rules.ts",
  "apps/engine/scripts/audit/ratchets.ts",
  "apps/engine/scripts/audit/transitive-purity.ts",
  "apps/engine/scripts/check-mutation-floor.ts",
  "apps/engine/scripts/check-coverage-floor.ts",
  "apps/engine/scripts/prepare-mutation-run.ts",
  "apps/engine/scripts/prepare-mutation-shards.ts",
  "apps/engine/.mutation-equivalents.json",
  "apps/engine/.coverage-floor.json",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "tsconfig.base.json",
  "apps/cockpit/tsconfig.json",
];

export function mutationTestInputs(repo: string): string[] {
  const candidates = RUNTIME_ROOTS.flatMap((root) =>
    listFiles(join(repo, root), (file) => RUNTIME_FILE.test(file)).map((file) =>
      relative(repo, file),
    ),
  );
  return [...new Set([...candidates, ...RUNNER_INPUTS])].sort();
}

export function digestFiles(
  repo: string,
  files: readonly string[],
  digest: (parts: readonly (string | Uint8Array)[]) => string,
): string {
  return digest(files.flatMap((file) => [file, "\0", readFileSync(join(repo, file)), "\0"]));
}
