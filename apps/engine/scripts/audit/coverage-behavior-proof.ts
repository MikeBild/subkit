import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createVerificationRun,
  finalizeVerificationRun,
  verificationRunsRoot,
} from "../../../../scripts/lib/verification-run-lifecycle.ts";
import { runIsolatedTestFile } from "../../../subkit/src/tests/run-isolated-test-file.ts";

export type CoverageBehaviorProof = {
  version: 2;
  wave_id: string;
  manifest_sha256: string;
  source_sha256: string;
  test_sha256: string;
  config_sha256: string;
  context_sha256: string;
  resource_tags: string[];
  tests: string[];
  executed_tests: string[];
  terminal: Array<{
    test: string;
    manifest_path: string;
    manifest_sha256: string;
    result_path: string;
    result_sha256: string;
    log_path: string;
    log_sha256: string;
  }>;
};
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const exact = (actual: readonly string[], expected: readonly string[]) =>
  JSON.stringify(actual) === JSON.stringify(expected);

function containedRegular(root: string, path: string): void {
  const resolvedRoot = resolve(root),
    resolved = resolve(path),
    rel = relative(resolvedRoot, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("behavior artifact escapes root");
  for (let cursor = resolved; ; cursor = resolve(cursor, "..")) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("behavior artifact is a symlink");
    if (cursor === resolvedRoot) break;
  }
  if (!lstatSync(resolved).isFile()) throw new Error("behavior artifact is not a regular file");
}

export async function executeCoverageBehaviorTests(input: {
  repo: string;
  artifactRoot: string;
  owner: string;
  sourceDigest: string;
  contextSha256: string;
  tests: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<CoverageBehaviorProof["terminal"]> {
  mkdirSync(input.artifactRoot, { recursive: true, mode: 0o700 });
  const terminal: CoverageBehaviorProof["terminal"] = [];
  for (const test of sorted(input.tests)) {
    const run = createVerificationRun({
      root: verificationRunsRoot(input.repo),
      owner: `${input.owner}:${hash(test).slice(0, 12)}`,
      sourceDigest: input.sourceDigest,
      retention: "regular",
      logPath: "runner.log",
    });
    const logPath = join(run.directory, "runner.log"),
      resultPath = join(run.directory, "result.json");
    writeFileSync(logPath, "", { mode: 0o600, flag: "wx" });
    let outcome:
      | { exitCode: number | null; signal: string | null; timedOut: boolean; error: string | null }
      | undefined;
    let failure: unknown;
    try {
      await runIsolatedTestFile(test, {
        cwd: input.repo,
        deadlineMs: 300_000,
        env: input.env,
        onTerminal: (value) => {
          outcome = value;
        },
        onOutput: (chunk) => appendFileSync(logPath, chunk),
      });
    } catch (error) {
      failure = error;
    }
    const status =
      failure === undefined && outcome?.exitCode === 0 && !outcome.timedOut && !outcome.error
        ? "passed"
        : "failed";
    writeFileSync(
      resultPath,
      json({
        status,
        test,
        context_sha256: input.contextSha256,
        outcome: outcome ?? null,
        error: failure === undefined ? null : String(failure),
      }),
      { mode: 0o600, flag: "wx" },
    );
    finalizeVerificationRun(run, { status, resultPath: "result.json", logPath: "runner.log" });
    if (failure !== undefined) throw failure;
    const copy = (suffix: string, source: string) => {
      const destination = join(
        input.artifactRoot,
        `${hash(`${test}\0${suffix}\0${run.manifest.runId}`)}.${suffix}`,
      );
      writeFileSync(destination, readFileSync(source), { mode: 0o600, flag: "wx" });
      return destination;
    };
    const manifest = copy("manifest.json", join(run.directory, "manifest.json"));
    const result = copy("result.json", resultPath);
    const log = copy("runner.log", logPath);
    terminal.push({
      test,
      manifest_path: relative(input.repo, manifest),
      manifest_sha256: hash(readFileSync(manifest)),
      result_path: relative(input.repo, result),
      result_sha256: hash(readFileSync(result)),
      log_path: relative(input.repo, log),
      log_sha256: hash(readFileSync(log)),
    });
  }
  return terminal;
}

export function validateCoverageBehaviorProof(input: {
  text: string;
  sha256: string;
  repo: string;
  wave_id: string;
  manifest_sha256: string;
  source_sha256: string;
  test_sha256: string;
  config_sha256: string;
  context_sha256?: string;
  resource_tags: readonly string[];
  tests: readonly string[];
  executed_tests: readonly string[];
}): CoverageBehaviorProof {
  if (hash(input.text) !== input.sha256) throw new Error("behavior proof hash differs");
  const proof = JSON.parse(input.text) as CoverageBehaviorProof;
  if (
    proof.version !== 2 ||
    proof.wave_id !== input.wave_id ||
    proof.manifest_sha256 !== input.manifest_sha256 ||
    proof.source_sha256 !== input.source_sha256 ||
    proof.test_sha256 !== input.test_sha256 ||
    proof.config_sha256 !== input.config_sha256 ||
    (input.context_sha256 !== undefined && proof.context_sha256 !== input.context_sha256) ||
    !/^[a-f0-9]{64}$/.test(proof.context_sha256) ||
    !exact(sorted(proof.resource_tags), sorted(input.resource_tags)) ||
    !exact(proof.tests, sorted(input.tests)) ||
    !exact(proof.executed_tests, sorted(input.executed_tests)) ||
    !proof.tests.every((test) => proof.executed_tests.includes(test)) ||
    !Array.isArray(proof.terminal) ||
    !exact(proof.terminal.map((item) => item.test).sort(), proof.executed_tests)
  )
    throw new Error("behavior proof binding differs");
  for (const item of proof.terminal) {
    for (const [path, digest] of [
      [item.manifest_path, item.manifest_sha256],
      [item.result_path, item.result_sha256],
      [item.log_path, item.log_sha256],
    ] as const) {
      if (typeof path !== "string" || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
        throw new Error("behavior artifact reference differs");
      const absolute = join(input.repo, path);
      containedRegular(input.repo, absolute);
      if (hash(readFileSync(absolute)) !== digest)
        throw new Error("behavior artifact hash differs");
    }
    const manifest = JSON.parse(
      readFileSync(join(input.repo, item.manifest_path), "utf8"),
    ) as Record<string, unknown>;
    const result = JSON.parse(readFileSync(join(input.repo, item.result_path), "utf8")) as Record<
      string,
      unknown
    >;
    const outcome = result.outcome as Record<string, unknown> | null;
    if (
      manifest.status !== "passed" ||
      result.status !== "passed" ||
      result.test !== item.test ||
      !outcome ||
      outcome.exitCode !== 0 ||
      outcome.timedOut !== false ||
      outcome.error !== null ||
      result.context_sha256 !== proof.context_sha256
    )
      throw new Error("behavior test did not have a native passing terminal outcome");
  }
  return proof;
}

export function exportCoverageBehaviorProof(input: {
  sourceRepo: string;
  destinationRepo: string;
  destinationDir: string;
  text: string;
}): { text: string; sha256: string } {
  const proof = JSON.parse(input.text) as CoverageBehaviorProof;
  const root = join(input.destinationRepo, input.destinationDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const copy = (path: string, label: string) => {
    const destination = join(root, `${hash(`${label}\0${path}`)}.native`);
    writeFileSync(destination, readFileSync(join(input.sourceRepo, path)), {
      mode: 0o600,
      flag: "wx",
    });
    return relative(input.destinationRepo, destination);
  };
  proof.terminal = proof.terminal.map((item) => {
    const manifest_path = copy(item.manifest_path, "manifest");
    const result_path = copy(item.result_path, "result");
    const log_path = copy(item.log_path, "log");
    return {
      ...item,
      manifest_path,
      manifest_sha256: hash(readFileSync(join(input.destinationRepo, manifest_path))),
      result_path,
      result_sha256: hash(readFileSync(join(input.destinationRepo, result_path))),
      log_path,
      log_sha256: hash(readFileSync(join(input.destinationRepo, log_path))),
    };
  });
  const text = json(proof);
  writeFileSync(join(root, "behavior-proof.json"), text, { mode: 0o600, flag: "wx" });
  return { text, sha256: hash(text) };
}
