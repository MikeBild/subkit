import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportShardQualityEvidence } from "../../../scripts/export-shard-quality-evidence.ts";
import { verificationRunsRoot } from "../../../scripts/lib/verification-run-lifecycle.ts";
import { runWithVerificationLog } from "../../../scripts/run-with-verification-log.ts";
import { executeCoverageWave } from "./run-coverage-shards.ts";
import { executeExternalRuntimeAcceptance } from "./run-external-runtime-acceptance.ts";
import { executeMutationWave } from "./run-mutation-shards.ts";

const repo = resolve(import.meta.dir, "../../..");

export async function verifyReleaseQuality(): Promise<string> {
  if (!process.env.SUBKIT_COVERAGE_OWNED_DATABASE_URL)
    throw new Error("Release quality requires a job-owned PostgreSQL resource");
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
      owner: `release-quality:${waveId}:${script}`,
      command: "bun",
      args: ["run", `apps/engine/scripts/${script}`, ...args],
      cwd: repo,
      env: process.env,
      retention: "pinned",
      timeoutMs: 15 * 60_000,
    });
    if (code !== 0) throw new Error(`Release quality preparation failed: ${script}`);
  }
  const options = { repo, manifestPath: join(repo, manifest), timeoutMs: 12 * 60 * 60_000 };
  const coverageUnionPath = await executeCoverageWave(options);
  const mutationUnionPath = await executeMutationWave(options);
  const externalRuntimeAcceptancePath = await executeExternalRuntimeAcceptance({
    repo,
    manifestPath: join(repo, manifest),
  });
  return exportShardQualityEvidence({
    repo,
    coverageUnionPath,
    mutationUnionPath,
    ...(externalRuntimeAcceptancePath ? { externalRuntimeAcceptancePath } : {}),
    destination: join(repo, "reports/quality-export/shards"),
  });
}

if (import.meta.main) console.log(await verifyReleaseQuality());
