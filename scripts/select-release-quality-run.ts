import { readFileSync } from "node:fs";

export type QualityWorkflowRun = Readonly<{
  id: number;
  head_sha: string;
  head_repository: { full_name: string } | null;
  path: string;
  event: string;
  head_branch: string | null;
  status: string;
  conclusion: string | null;
  run_attempt: number;
}>;

const QUALITY_PATH = ".github/workflows/quality.yml";

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isExactQualityPush(
  value: unknown,
  { commit, repository }: { commit: string; repository: string },
): value is QualityWorkflowRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<QualityWorkflowRun>;
  return (
    validId(run.id) &&
    run.head_sha === commit &&
    run.head_repository?.full_name === repository &&
    run.path === QUALITY_PATH &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    validAttempt(run.run_attempt)
  );
}

export function selectReleaseQualityRun(options: {
  commit: string;
  repository: string;
  runs: unknown;
}): QualityWorkflowRun {
  if (!/^[a-f0-9]{40}$/.test(options.commit) || !/^[\w.-]+\/[\w.-]+$/.test(options.repository))
    throw new Error("invalid quality producer identity");
  const response =
    options.runs &&
    typeof options.runs === "object" &&
    Array.isArray((options.runs as { workflow_runs?: unknown }).workflow_runs)
      ? (options.runs as { workflow_runs: unknown[]; total_count?: unknown })
      : undefined;
  if (
    !response ||
    !Number.isSafeInteger(response.total_count) ||
    response.total_count < 0 ||
    response.total_count !== response.workflow_runs.length
  )
    throw new Error("quality workflow response is incomplete or malformed");
  const list = response.workflow_runs;
  const eligible = list.filter((run) => isExactQualityPush(run, options));
  if (eligible.length !== 1)
    throw new Error(
      `expected exactly one completed successful exact-commit quality producer, found ${eligible.length}`,
    );
  return eligible[0]!;
}

export function verifySelectedReleaseQualityRun(options: {
  commit: string;
  repository: string;
  runId: string;
  runAttempt: string;
  run: unknown;
}): QualityWorkflowRun {
  if (!/^\d+$/.test(options.runId) || !/^\d+$/.test(options.runAttempt))
    throw new Error("quality producer id and attempt must be numeric");
  if (!isExactQualityPush(options.run, options))
    throw new Error("quality producer no longer satisfies exact-run policy");
  if (
    String(options.run.id) !== options.runId ||
    String(options.run.run_attempt) !== options.runAttempt
  )
    throw new Error("quality producer changed after selection");
  return options.run;
}

export type QualityArtifact = Readonly<{
  id: number;
  name: string;
  expired: boolean;
  digest: string;
  workflow_run: { id: number; head_sha: string } | null;
}>;

export function selectReleaseQualityArtifacts(options: {
  commit: string;
  runId: string;
  artifacts: unknown;
}): Readonly<{
  coverageFloorEvidenceId: number;
  coverageFloorEvidenceDigest: string;
}> {
  if (!/^[a-f0-9]{40}$/.test(options.commit) || !/^\d+$/.test(options.runId))
    throw new Error("invalid quality artifact identity");
  const response =
    options.artifacts &&
    typeof options.artifacts === "object" &&
    Array.isArray((options.artifacts as { artifacts?: unknown }).artifacts)
      ? (options.artifacts as { artifacts: unknown[]; total_count?: unknown })
      : undefined;
  if (
    !response ||
    !Number.isSafeInteger(response.total_count) ||
    response.total_count < 0 ||
    response.total_count !== response.artifacts.length
  )
    throw new Error("quality artifact response is incomplete or malformed");
  const list = response.artifacts;
  const pick = (name: string) => {
    const matching = list.filter(
      (value): value is QualityArtifact =>
        Boolean(value) && typeof value === "object" && (value as { name?: unknown }).name === name,
    );
    if (matching.length !== 1)
      throw new Error(`expected exactly one unexpired ${name} artifact, found ${matching.length}`);
    const artifact = matching[0]!;
    if (
      !validId(artifact.id) ||
      artifact.expired !== false ||
      typeof artifact.digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
      !artifact.workflow_run ||
      !validId(artifact.workflow_run.id) ||
      typeof artifact.workflow_run.head_sha !== "string" ||
      artifact.workflow_run.id !== Number(options.runId) ||
      artifact.workflow_run.head_sha !== options.commit
    )
      throw new Error(`expected exactly one unexpired ${name} artifact, found 0`);
    return { id: artifact.id, digest: artifact.digest };
  };
  const coverage = pick("coverage-floor-evidence");
  return {
    coverageFloorEvidenceId: coverage.id,
    coverageFloorEvidenceDigest: coverage.digest,
  };
}

function values(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key?.startsWith("--") || !value || result.has(key)) throw new Error("invalid arguments");
    result.set(key, value);
  }
  return result;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const args = values([command ?? "", ...rest]);
  const commit = args.get("--commit"),
    repository = args.get("--repository"),
    input = args.get("--input");
  if (!commit || !repository || !input)
    throw new Error("--commit --repository and --input are required");
  const parsed = JSON.parse(readFileSync(input, "utf8")) as unknown;
  if (command === "select") {
    if (args.size !== 3) throw new Error("select accepts only --commit --repository --input");
    const run = selectReleaseQualityRun({ commit, repository, runs: parsed });
    console.log(JSON.stringify({ id: run.id, run_attempt: run.run_attempt }));
  } else if (command === "verify") {
    const runId = args.get("--run-id"),
      runAttempt = args.get("--run-attempt");
    if (!runId || !runAttempt || args.size !== 5)
      throw new Error("verify requires --commit --repository --run-id --run-attempt --input");
    const run = verifySelectedReleaseQualityRun({
      commit,
      repository,
      runId,
      runAttempt,
      run: parsed,
    });
    console.log(JSON.stringify({ id: run.id, run_attempt: run.run_attempt }));
  } else if (command === "artifacts") {
    const runId = args.get("--run-id");
    if (!runId || args.size !== 4)
      throw new Error("artifacts requires --commit --repository --run-id --input");
    console.log(
      JSON.stringify(selectReleaseQualityArtifacts({ commit, runId, artifacts: parsed })),
    );
  } else throw new Error("usage: select-release-quality-run.ts select|verify ...");
}
