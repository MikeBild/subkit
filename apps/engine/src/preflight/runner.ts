// Process-level orchestration for the bootstrap preflight and the operator
// commands. Everything that talks to `process` lives here so `checks.ts` and
// `vault-cli.ts` stay pure and unit-testable.

import type { Config } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/logger.ts";
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

/** True when this process is a production start. */
export function isProduction(): boolean {
  return (process.env.NODE_ENV ?? "").toLowerCase() === "production";
}

/**
 * Log the passing checks and the two notes the contract names. Refusals are
 * NOT logged here — a refusal owns the single structured line, and a
 * `logger.fatal` beside it would be a second, differently-shaped record of
 * the same fact.
 */
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

/**
 * Run the checks and turn the outcome into the `{exitCode, lines}` shape the
 * operator commands share. A refusal is exactly one line — the JSON object
 * the contract fixes — and exit 3.
 */
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

/**
 * The automatic production run: the first thing the process does, before any
 * schema migration, before any settings revision is written, before any
 * listener opens. On refusal it prints the one line and exits 3, having
 * changed nothing — so a rollback to the previous release is still possible.
 *
 * A no-op outside production: local development and the test harness run
 * without an object store and against an ephemeral database, and refusing
 * them would only teach operators to set an escape hatch.
 */
export async function runProductionPreflightOrExit(db: Db, cfg: Config): Promise<void> {
  if (!isProduction()) {
    logger.debug({
      module: "preflight",
      action: "preflight.skipped_non_production",
      msg: "bootstrap preflight runs on production starts only",
      node_env: process.env.NODE_ENV ?? "development",
    });
    return;
  }
  const outcome = await preflightOutcome(db, cfg);
  if (outcome.exitCode === PREFLIGHT_EXIT_OK) return;
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  process.exit(outcome.exitCode);
}
