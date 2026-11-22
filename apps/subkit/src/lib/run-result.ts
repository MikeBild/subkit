import { printJson } from "@cli-core/format";
import pc from "picocolors";
import type { EngineClient, RunEnvironment, RunExecutionResponse } from "../engine-client.ts";
import { computeStepBottlenecks, humanMs } from "../render/format.ts";
import { heldRunBlock } from "./held-run.ts";
import { environmentMismatchHint } from "./run-environment.ts";

export function printRunResult(
  result: RunExecutionResponse,
  environment: RunEnvironment,
  held?: { client: EngineClient; workflowId: string },
): void {
  printJson(result.idempotent_replay ? result : { ...result, environment });
  if (result.idempotent_replay) {
    process.stderr.write(
      `\n${pc.dim("note:")} nothing new was started — an earlier run already used this idempotency key; it kept its own environment\n`,
    );
  } else {
    process.stderr.write(`\n${pc.dim("environment:")} ${environment}\n`);
  }
  const mismatchHint = environmentMismatchHint(result, environment);
  if (mismatchHint) process.stderr.write(`\n${pc.yellow("hint:")} ${mismatchHint}\n`);
  if (held) {
    const block = heldRunBlock(
      held.client,
      { hold_writes: result.hold_writes === true, workflow_id: held.workflowId },
      (result.steps ?? []) as unknown as Record<string, unknown>[],
    );
    if (block) process.stderr.write(`\n${pc.bold(pc.yellow(block))}\n`);
  }
  const warnings = (result.warnings ?? []) as Array<{
    step_key?: string;
    code?: string;
    message?: string;
  }>;
  if (warnings.length > 0) {
    process.stderr.write(`\n${pc.dim("warnings:")}\n`);
    for (const w of warnings) {
      const step = w.step_key ?? "(run)";
      const code = w.code ?? "unknown";
      const msg = w.message ?? "";
      process.stderr.write(`  ${pc.yellow("WARN")} step=${step} code=${code} msg=${msg}\n`);
    }
  }
  const ranked = computeStepBottlenecks(
    (result.steps ?? []) as unknown as Array<Record<string, unknown>>,
  );
  const slowest = ranked[0];
  if (slowest) {
    const conn = slowest.connector_slug ? ` ${pc.dim(`(${slowest.connector_slug})`)}` : "";
    process.stderr.write(
      `\n${pc.dim("slowest step:")} ${pc.cyan(slowest.step_key)} ` +
        `${humanMs(slowest.duration_ms)} (${slowest.pct.toFixed(0)}% of run)${conn}\n`,
    );
  }
  const rs = result.connector_resolutions ?? [];
  if (rs.length === 0) return;
  process.stderr.write(`\n${pc.dim("connector resolutions:")}\n`);
  for (const r of rs) {
    const env = `${r.requested_environment} → ${r.resolved_environment}`;
    process.stderr.write(
      `  ${pc.cyan(r.step_key)}  ${r.connector_slug} (${r.driver})  ${env}  ${pc.yellow(r.auth_method)}\n`,
    );
  }
}
