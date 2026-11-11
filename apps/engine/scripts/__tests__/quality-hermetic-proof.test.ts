import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("hermetic CI processes exchange native proofs and reject changed semantic inputs", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "quality-hermetic-proof-"));
  const repo = join(root, "repo");
  const script = join(root, "quality.ts");
  const modulePath = (name: string) => JSON.stringify(join(import.meta.dir, "../audit", name));
  mkdirSync(repo);
  writeFileSync(
    join(repo, "passing.test.ts"),
    'import { test } from "bun:test"; test("native", () => {});\n',
  );
  writeFileSync(
    script,
    `
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHermeticQualityAction } from ${modulePath("quality-hermetic-launcher.ts")};
import { coverageExecutionContext, coverageTestEnvironment } from ${modulePath("coverage-environment.ts")};
import { executeCoverageBehaviorTests, validateCoverageBehaviorProof } from ${modulePath("coverage-behavior-proof.ts")};
const action = process.argv[2];
if (process.env.SUBKIT_QUALITY_HERMETIC_CI === "1")
  runHermeticQualityAction({ executable: process.execPath, script: import.meta.path, action, ambient: process.env });
if (process.env.SUBKIT_QUALITY_HERMETIC_CI !== undefined || process.env.AMBIENT_JOB_NONCE !== undefined)
  throw new Error("Ambient launcher inputs leaked into the child");
const repo = ${JSON.stringify(repo)};
const hash = value => createHash("sha256").update(value).digest("hex");
const env = coverageTestEnvironment(process.env, process.env.SUBKIT_COVERAGE_OWNED_DATABASE_URL);
const expected = {
  wave_id: "fixture", manifest_sha256: "a".repeat(64), source_sha256: "b".repeat(64),
  test_sha256: "c".repeat(64), config_sha256: "d".repeat(64), resource_tags: [],
  tests: ["passing.test.ts"], executed_tests: ["passing.test.ts"],
  context_sha256: hash(JSON.stringify(coverageExecutionContext(env, []), null, 2) + "\\n"),
};
if (action === "prepare") {
  const terminal = await executeCoverageBehaviorTests({
    repo, artifactRoot: join(repo, "evidence"), owner: "hermetic-proof-regression",
    sourceDigest: expected.source_sha256, contextSha256: expected.context_sha256,
    tests: expected.tests, env,
  });
  writeFileSync(join(repo, "proof.json"), JSON.stringify({ version: 2, ...expected, terminal }));
} else {
  const text = readFileSync(join(repo, "proof.json"), "utf8");
  validateCoverageBehaviorProof({ ...expected, repo, text, sha256: hash(text) });
}
console.log("verified");
`,
  );
  const run = (action: string, overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script, action], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        TMPDIR: root,
        SUBKIT_QUALITY_HERMETIC_CI: "1",
        SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://fixture/owned",
        MASTER_KEY: "a".repeat(64),
        GITHUB_RUN_ID: "123",
        AMBIENT_JOB_NONCE: action,
        ...overrides,
      },
    });
  try {
    for (const action of ["prepare", "coverage"]) {
      const result = run(action);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("verified");
    }
    for (const change of [
      { MASTER_KEY: "b".repeat(64) },
      { SUBKIT_COVERAGE_OWNED_DATABASE_URL: "postgres://fixture/changed" },
    ]) {
      const result = run("coverage", change);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("behavior proof binding differs");
    }
    const bypass = run("coverage", { SUBKIT_QUALITY_HERMETIC_LAUNCHER: "1" });
    expect(bypass.status).not.toBe(0);
    expect(bypass.stderr).toContain("rejects undeclared SUBKIT inputs");
    expect(readdirSync(root).filter((name) => name.startsWith("subkit-quality-home-"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
