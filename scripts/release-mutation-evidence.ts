import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { executeMutationWave } from "../apps/engine/scripts/run-mutation-shards.ts";
import { verificationRunsRoot } from "./lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "./run-with-verification-log.ts";

export interface ReleaseMutationReceipt {
  version: 1;
  commit_sha: string;
  tree_sha: string;
  wave_id: string;
  run_id: string;
  union_path: string;
  union_sha256: string;
  detected: number;
  undetected: number;
  equivalent_excluded: number;
  recorded_at: string;
}

export const RELEASE_MUTATION_COMMAND = "bun run test:mutation:release";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function releaseMutationReceiptPath(repo: string, commit: string): string {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("release mutation commit is malformed");
  return join(repo, "reports/mutation/release", `${commit}.json`);
}

function unionScore(unionText: string): {
  waveId: string;
  runId: string;
  detected: number;
  undetected: number;
  equivalentExcluded: number;
} {
  const union = JSON.parse(unionText) as {
    wave_id?: unknown;
    run_id?: unknown;
    adjusted_mutation_score?: unknown;
    score_summary?: { detected?: unknown; undetected?: unknown; equivalent_excluded?: unknown };
  };
  const summary = union.score_summary;
  if (
    typeof union.wave_id !== "string" ||
    typeof union.run_id !== "string" ||
    !summary ||
    !Number.isSafeInteger(summary.detected) ||
    !Number.isSafeInteger(summary.undetected) ||
    !Number.isSafeInteger(summary.equivalent_excluded)
  )
    throw new Error("release mutation union is malformed");
  if (
    union.adjusted_mutation_score !== 100 ||
    summary.undetected !== 0 ||
    (summary.detected as number) < 1
  )
    throw new Error("release mutation union has undetected mutants");
  return {
    waveId: union.wave_id,
    runId: union.run_id,
    detected: summary.detected as number,
    undetected: summary.undetected as number,
    equivalentExcluded: summary.equivalent_excluded as number,
  };
}

export function buildReleaseMutationReceipt(input: {
  commit: string;
  tree: string;
  unionPath: string;
  unionText: string;
  recordedAt: string;
}): ReleaseMutationReceipt {
  const score = unionScore(input.unionText);
  return {
    version: 1,
    commit_sha: input.commit,
    tree_sha: input.tree,
    wave_id: score.waveId,
    run_id: score.runId,
    union_path: input.unionPath,
    union_sha256: hash(input.unionText),
    detected: score.detected,
    undetected: score.undetected,
    equivalent_excluded: score.equivalentExcluded,
    recorded_at: input.recordedAt,
  };
}

export function assertReleaseMutationReceipt(input: {
  receiptText: string | null;
  commit: string;
  tree: string;
  readUnion: (path: string) => string | null;
}): ReleaseMutationReceipt {
  if (input.receiptText === null)
    throw new Error(
      `no mutation evidence for commit ${input.commit}. Run \`${RELEASE_MUTATION_COMMAND}\` first.`,
    );
  const receipt = JSON.parse(input.receiptText) as Partial<ReleaseMutationReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.union_path !== "string" ||
    !/^reports\/mutation\/runs\/[a-z0-9-]+\/[a-z0-9-]+\/union\.json$/.test(receipt.union_path) ||
    typeof receipt.union_sha256 !== "string" ||
    Number.isNaN(Date.parse(receipt.recorded_at ?? ""))
  )
    throw new Error("release mutation evidence is malformed");
  if (receipt.commit_sha !== input.commit || receipt.tree_sha !== input.tree)
    throw new Error("release mutation evidence belongs to another commit");
  const unionText = input.readUnion(receipt.union_path);
  if (unionText === null || hash(unionText) !== receipt.union_sha256)
    throw new Error("release mutation union is missing or changed");
  const score = unionScore(unionText);
  if (
    receipt.wave_id !== score.waveId ||
    receipt.run_id !== score.runId ||
    receipt.detected !== score.detected ||
    receipt.undetected !== score.undetected ||
    receipt.equivalent_excluded !== score.equivalentExcluded
  )
    throw new Error("release mutation evidence differs from its union");
  return receipt as ReleaseMutationReceipt;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function cleanHead(repo: string): { commit: string; tree: string } {
  if (git(repo, "status", "--porcelain") !== "")
    throw new Error("release mutation evidence requires a clean working tree");
  return { commit: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") };
}

export async function recordReleaseMutationEvidence(repo: string): Promise<string> {
  if (!process.env.SUBKIT_COVERAGE_OWNED_DATABASE_URL)
    throw new Error("Release mutation requires a job-owned PostgreSQL resource");
  const head = cleanHead(repo);
  const waveId = `release-${randomUUID()}`;
  const inputRoot = `reports/quality-inputs/${waveId}`;
  const ledger = `${inputRoot}/runtime-ledger.json`;
  const candidate = `${inputRoot}/candidate.json`;
  const manifest = `${inputRoot}/wave.json`;
  mkdirSync(join(repo, inputRoot), { recursive: true });
  const stages = [
    ["record-quality-runtime-witnesses.ts", "--out", ledger],
    [
      "generate-quality-wave.ts",
      "--dynamic-ledger",
      ledger,
      "--wave-id",
      waveId,
      "--out",
      candidate,
    ],
    [
      "prepare-mutation-shards.ts",
      "--manifest",
      candidate,
      "--dynamic-ledger",
      ledger,
      "--out",
      manifest,
    ],
  ] as const;
  for (const [script, ...args] of stages) {
    const code = await runWithVerificationLog({
      root: verificationRunsRoot(repo),
      owner: `release-mutation:${waveId}:${script}`,
      command: "bun",
      args: ["run", `apps/engine/scripts/${script}`, ...args],
      cwd: repo,
      env: process.env,
      timeoutMs: 15 * 60_000,
    });
    if (code !== 0) throw new Error(`Release mutation preparation failed: ${script}`);
  }
  const unionPath = await executeMutationWave({
    repo,
    manifestPath: join(repo, manifest),
    timeoutMs: 6 * 60 * 60_000,
  });
  const finished = cleanHead(repo);
  if (finished.commit !== head.commit || finished.tree !== head.tree)
    throw new Error("release mutation commit changed during the run");
  const receipt = buildReleaseMutationReceipt({
    commit: head.commit,
    tree: head.tree,
    unionPath: relative(repo, unionPath),
    unionText: readFileSync(unionPath, "utf8"),
    recordedAt: new Date().toISOString(),
  });
  const output = releaseMutationReceiptPath(repo, head.commit);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.pending`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, output);
  return output;
}

export function checkReleaseMutationEvidence(repo: string): ReleaseMutationReceipt {
  const head = cleanHead(repo);
  const receiptPath = releaseMutationReceiptPath(repo, head.commit);
  return assertReleaseMutationReceipt({
    receiptText: existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null,
    commit: head.commit,
    tree: head.tree,
    readUnion: (path) => {
      const absolute = join(repo, path);
      return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    },
  });
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, "..");
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (mode !== "run" && mode !== "check"))
    throw new Error("usage: release-mutation-evidence.ts run|check");
  try {
    if (mode === "run") console.log(await recordReleaseMutationEvidence(repo));
    else {
      const receipt = checkReleaseMutationEvidence(repo);
      console.log(
        `release mutation evidence: ${receipt.detected} detected, ${receipt.undetected} undetected, ${receipt.equivalent_excluded} equivalent, commit ${receipt.commit_sha}`,
      );
    }
  } catch (error) {
    console.error(`release mutation evidence: ${(error as Error).message}`);
    process.exit(1);
  }
}
