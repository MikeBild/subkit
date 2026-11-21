import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listFiles } from "./files.ts";

const RUNTIME_ROOTS = ["apps/cockpit/src", "apps/engine/src", "apps/sk/src", "packages"];
const RUNTIME_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|wat)$/;

interface PackagePatchManifest {
  readonly patchedDependencies?: Record<string, unknown>;
}

function isInsideRepo(repo: string, file: string): boolean {
  const pathFromRepo = relative(repo, file);
  return pathFromRepo !== "" && !pathFromRepo.startsWith(`..${sep}`) && pathFromRepo !== "..";
}

function hasSymlinkPathComponent(repo: string, file: string): boolean {
  let current = repo;
  for (const component of relative(repo, file).split(sep)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function patchedDependencyInputs(repo: string): string[] {
  const repoRoot = realpathSync(repo);
  const packageManifest = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as PackagePatchManifest;
  const declarations =
    packageManifest.patchedDependencies === undefined ? {} : packageManifest.patchedDependencies;
  if (typeof declarations !== "object" || declarations === null || Array.isArray(declarations))
    throw new Error("package.json patchedDependencies must be an object");

  const declared = Object.entries(declarations).map(([dependency, patch]) => {
    if (typeof patch !== "string" || patch.length === 0)
      throw new Error(`patched dependency ${dependency} must declare a nonempty patch path`);
    if (isAbsolute(patch))
      throw new Error(`patched dependency ${dependency} uses an absolute patch path`);
    const candidate = resolve(repoRoot, patch);
    if (!isInsideRepo(repoRoot, candidate))
      throw new Error(`patched dependency ${dependency} escapes the repository`);
    if (!existsSync(candidate))
      throw new Error(`patched dependency ${dependency} patch is missing`);
    if (hasSymlinkPathComponent(repoRoot, candidate))
      throw new Error(`patched dependency ${dependency} patch must not traverse a symlink`);
    const metadata = lstatSync(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`patched dependency ${dependency} patch must be a regular non-symlink file`);
    const canonical = realpathSync(candidate);
    if (!isInsideRepo(repoRoot, canonical))
      throw new Error(`patched dependency ${dependency} patch resolves outside the repository`);
    return relative(repoRoot, canonical);
  });
  if (new Set(declared).size !== declared.length)
    throw new Error("patchedDependencies must not bind more than one dependency to the same patch");

  const patchRoot = join(repoRoot, "patches");
  const actual = existsSync(patchRoot)
    ? listFiles(patchRoot, (file) => file.endsWith(".patch")).map((file) =>
        relative(repoRoot, file),
      )
    : [];
  const unbound = actual.filter((file) => !declared.includes(file));
  if (unbound.length > 0) throw new Error(`unbound patch files: ${unbound.sort().join(", ")}`);
  return declared.sort();
}
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
  "apps/engine/scripts/__tests__/native-exact-ignored-mutants.test.ts",
  "apps/engine/scripts/audit/distributed-quality-ticket.ts",
  "apps/engine/.quality-shard-policy.json",
  "apps/engine/scripts/audit/quality-shard-policy.ts",
  "apps/engine/scripts/audit/quality-runtime-witness-policy.ts",
  "apps/engine/scripts/record-quality-runtime-witnesses.ts",
  "apps/engine/scripts/generate-quality-wave.ts",
  "apps/engine/scripts/audit/quality-wave-manifest.ts",
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
  "apps/engine/scripts/audit/mutation-validation-ticket.ts",
  "apps/engine/scripts/audit/mutation-ticket-evidence.ts",
  "apps/engine/scripts/audit/mutation-infrastructure-sentinel.ts",
  "apps/engine/scripts/audit/mutation-shard-config.ts",
  "apps/engine/scripts/audit/mutation-union.ts",
  "apps/engine/scripts/audit/mutation-shard-score.ts",
  "apps/engine/scripts/audit/coverage-union.ts",
  "apps/engine/scripts/audit/coverage-behavior-proof.ts",
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
  "scripts/lib/bounded-output-log.ts",
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
  "apps/engine/scripts/audit/mutation-runtime-snapshot.ts",
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
  return [...new Set([...candidates, ...RUNNER_INPUTS, ...patchedDependencyInputs(repo)])].sort();
}

export function digestFiles(
  repo: string,
  files: readonly string[],
  digest: (parts: readonly (string | Uint8Array)[]) => string,
): string {
  return digest(files.flatMap((file) => [file, "\0", readFileSync(join(repo, file)), "\0"]));
}
