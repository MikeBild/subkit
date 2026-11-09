import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runIsolatedTestFile } from "../../../sk/src/tests/run-isolated-test-file.ts";
import {
  type CoverageBehaviorProof,
  executeCoverageBehaviorTests,
  exportCoverageBehaviorProof,
  validateCoverageBehaviorProof,
} from "../audit/coverage-behavior-proof.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const repo = process.cwd();
function fixture() {
  const root = join(repo, ".artifacts", "coverage-behavior-proof-test", randomUUID());
  mkdirSync(root, { recursive: true });
  const manifestPath = join(root, "manifest.json"),
    resultPath = join(root, "result.json"),
    logPath = join(root, "runner.log");
  writeFileSync(manifestPath, JSON.stringify({ status: "passed" }));
  writeFileSync(
    resultPath,
    JSON.stringify({
      status: "passed",
      test: "consumer.test.ts",
      context_sha256: "e".repeat(64),
      outcome: { exitCode: 0, timedOut: false, error: null },
    }),
  );
  writeFileSync(logPath, "native output\n");
  const proof = {
    version: 2,
    wave_id: "wave",
    manifest_sha256: "a".repeat(64),
    source_sha256: "b".repeat(64),
    test_sha256: "c".repeat(64),
    config_sha256: "d".repeat(64),
    context_sha256: "e".repeat(64),
    resource_tags: ["db"],
    tests: ["consumer.test.ts"],
    executed_tests: ["consumer.test.ts"],
    terminal: [
      {
        test: "consumer.test.ts",
        manifest_path: relative(repo, manifestPath),
        manifest_sha256: digest(readFileSync(manifestPath, "utf8")),
        result_path: relative(repo, resultPath),
        result_sha256: digest(readFileSync(resultPath, "utf8")),
        log_path: relative(repo, logPath),
        log_sha256: digest(readFileSync(logPath, "utf8")),
      },
    ],
  };
  const text = JSON.stringify(proof);
  return {
    root,
    text,
    sha256: digest(text),
    repo,
    wave_id: "wave",
    manifest_sha256: "a".repeat(64),
    source_sha256: "b".repeat(64),
    test_sha256: "c".repeat(64),
    config_sha256: "d".repeat(64),
    context_sha256: "e".repeat(64),
    resource_tags: ["db"],
    tests: ["consumer.test.ts"],
    executed_tests: ["consumer.test.ts"],
  };
}

test("requires exact native terminal evidence and rejects tamper, stale, duplicate, extra, failure and escape", () => {
  const value = fixture();
  try {
    expect(validateCoverageBehaviorProof(value).tests).toEqual(["consumer.test.ts"]);
    for (const mutate of [
      (proof: CoverageBehaviorProof) => {
        proof.context_sha256 = "f".repeat(64);
      },
      (proof: CoverageBehaviorProof) => {
        proof.executed_tests = [];
      },
      (proof: CoverageBehaviorProof) => {
        proof.executed_tests.push("extra.test.ts");
      },
      (proof: CoverageBehaviorProof) => {
        proof.terminal.push(proof.terminal[0]);
      },
      (proof: CoverageBehaviorProof) => {
        proof.terminal[0].result_path = "../escape";
      },
    ]) {
      const next = { ...value };
      const proof = JSON.parse(next.text) as CoverageBehaviorProof;
      mutate(proof);
      next.text = JSON.stringify(proof);
      next.sha256 = digest(next.text);
      expect(() => validateCoverageBehaviorProof(next)).toThrow();
    }
    const proof = JSON.parse(value.text) as CoverageBehaviorProof;
    writeFileSync(join(repo, proof.terminal[0].result_path), JSON.stringify({ status: "failed" }));
    expect(() => validateCoverageBehaviorProof(value)).toThrow();
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("exports, rebases, and revalidates the complete native terminal chain in a clone", () => {
  const value = fixture();
  const clone = mkdtempSync(join(tmpdir(), "coverage-behavior-clone-"));
  try {
    const portable = exportCoverageBehaviorProof({
      sourceRepo: repo,
      destinationRepo: clone,
      destinationDir: "evidence/behavior",
      text: value.text,
    });
    expect(
      validateCoverageBehaviorProof({ ...value, repo: clone, ...portable }).terminal,
    ).toHaveLength(1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("runs a real isolated child, exports its terminal chain, and rejects a failing child", async () => {
  const source = join(repo, ".artifacts", `coverage-behavior-source-${randomUUID()}`);
  const clone = join(repo, ".artifacts", `coverage-behavior-clone-${randomUUID()}`);
  mkdirSync(source, { recursive: true });
  mkdirSync(clone, { recursive: true });
  const artifactRoot = join(source, "reports", "coverage", "behavior");
  const expected = {
    wave_id: "wave",
    manifest_sha256: "a".repeat(64),
    source_sha256: "b".repeat(64),
    test_sha256: "c".repeat(64),
    config_sha256: "d".repeat(64),
    context_sha256: "e".repeat(64),
    resource_tags: [],
    tests: ["passing.test.ts"],
    executed_tests: ["passing.test.ts"],
  };
  try {
    writeFileSync(
      join(source, "passing.test.ts"),
      'import { test } from "bun:test"; test("pass", () => {});\n',
    );
    const terminal = await executeCoverageBehaviorTests({
      repo: source,
      artifactRoot,
      owner: "coverage-proof-smoke",
      sourceDigest: expected.source_sha256,
      contextSha256: expected.context_sha256,
      tests: expected.tests,
      env: { ...process.env, NODE_ENV: "test", LLM_PROVIDER: "mock" },
    });
    const text = JSON.stringify({ version: 2, ...expected, terminal });
    const portable = exportCoverageBehaviorProof({
      sourceRepo: source,
      destinationRepo: clone,
      destinationDir: "evidence/behavior",
      text,
    });
    rmSync(artifactRoot, { recursive: true, force: true });
    expect(
      validateCoverageBehaviorProof({ ...expected, repo: clone, ...portable }).terminal,
    ).toHaveLength(1);
    writeFileSync(
      join(source, "failing.test.ts"),
      'import { test, expect } from "bun:test"; test("fail", () => expect(1).toBe(2));\n',
    );
    await expect(
      executeCoverageBehaviorTests({
        repo: source,
        artifactRoot,
        owner: "coverage-proof-smoke",
        sourceDigest: expected.source_sha256,
        contextSha256: expected.context_sha256,
        tests: ["failing.test.ts"],
        env: { ...process.env, NODE_ENV: "test", LLM_PROVIDER: "mock" },
      }),
    ).rejects.toThrow();
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("rejects safely when an owned output sink fails", async () => {
  const root = join(repo, ".artifacts", `isolated-output-failure-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  try {
    writeFileSync(
      join(root, "output.test.ts"),
      'import { test } from "bun:test"; test("output", () => console.log("output"));\n',
    );
    await expect(
      runIsolatedTestFile("output.test.ts", {
        cwd: root,
        deadlineMs: 1_000,
        killGraceMs: 50,
        onOutput: () => {
          throw new Error("sink failed");
        },
      }),
    ).rejects.toThrow("sink failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
