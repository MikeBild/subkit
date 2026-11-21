import type { Config } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { readEnv } from "../env.ts";
import { logger } from "../logging/index.ts";
import { runPreflightChecks } from "./checks.ts";
import {
  firstRefusal,
  PREFLIGHT_EXIT_OK,
  PREFLIGHT_EXIT_REFUSED,
  type PreflightOutcome,
  refusalLine,
} from "./contracts.ts";
import { createPreflightEnvironment } from "./environment.ts";
import type { VaultCliOutcome } from "./vault-cli.ts";

export function isProduction(): boolean {
  return (readEnv("NODE_ENV") ?? "").toLowerCase() === "production";
}

export function logPreflightOutcome(outcome: PreflightOutcome): void {
  for (const result of outcome.results) {
    if (!result.ok) continue;
    logger.info({
      module: "preflight",
      action: `preflight.${result.check}.ok`,
      msg: `preflight ok: ${result.check}`,
      detail: result.detail ?? null,
    });
  }
  for (const note of outcome.notes) {
    logger.info({
      module: "preflight",
      action: note.action,
      msg: `${note.action} ${note.detail}`,
      detail: note.detail,
    });
  }
}

export async function preflightOutcome(db: Db, cfg: Config): Promise<VaultCliOutcome> {
  const outcome = await runPreflightChecks(createPreflightEnvironment(db, cfg));
  logPreflightOutcome(outcome);
  const refusal = firstRefusal(outcome);
  if (refusal) return { exitCode: PREFLIGHT_EXIT_REFUSED, lines: [refusalLine(refusal)] };
  return {
    exitCode: PREFLIGHT_EXIT_OK,
    lines: [`preflight: ${outcome.results.length} check(s) passed`],
  };
}

export async function runProductionPreflightOrExit(db: Db, cfg: Config): Promise<void> {
  if (!isProduction()) {
    logger.debug({
      module: "preflight",
      action: "preflight.skipped_non_production",
      msg: "bootstrap preflight runs on production starts only",
      node_env: readEnv("NODE_ENV") ?? "development",
    });
    return;
  }
  const outcome = await preflightOutcome(db, cfg);
  if (outcome.exitCode === PREFLIGHT_EXIT_OK) return;
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
