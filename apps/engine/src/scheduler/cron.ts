// Thin wrapper over pg-boss schedule / unschedule plus cron expression
// validation. pg-boss FK: `pgboss.schedule.name` references
// `pgboss.queue.name`, so `boss.schedule(name, ...)` requires the
// queue to exist first. `scheduleCron` upserts the queue before
// scheduling so the FK is always satisfiable. `every:N` shorthand
// fires every N seconds and is handled process-locally via
// `setInterval` instead of via pg-boss' (minute-resolution) cron.

import { CronExpressionParser } from "cron-parser";
import type { PgBoss } from "pg-boss";
import { logger } from "../logging/logger.ts";

export interface CronValidationResult {
  ok: boolean;
  reason?: string;
  mode: "cron" | "every";
  /** For every-mode the number of seconds between fires. */
  everySeconds?: number;
}

const EVERY_PREFIX = "every:";

export function parseCronExpression(expr: string): CronValidationResult {
  const trimmed = expr.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) {
    const rest = trimmed.slice(EVERY_PREFIX.length).trim();
    const n = Number.parseFloat(rest);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, mode: "every", reason: `invalid every expression: ${expr}` };
    }
    return { ok: true, mode: "every", everySeconds: n };
  }
  try {
    CronExpressionParser.parse(trimmed, { strict: false });
    return { ok: true, mode: "cron" };
  } catch (err) {
    return {
      ok: false,
      mode: "cron",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ScheduleCronOptions {
  boss: PgBoss;
  name: string;
  cron: string;
  payload?: object;
  tz?: string;
}

export async function scheduleCron(opts: ScheduleCronOptions): Promise<void> {
  const parsed = parseCronExpression(opts.cron);
  if (!parsed.ok) {
    throw new Error(`invalid cron expression for ${opts.name}: ${parsed.reason}`);
  }
  if (parsed.mode === "every") {
    // Handled locally — no-op here; reconciler runs an interval instead.
    return;
  }
  // Ensure the pg-boss queue exists before scheduling — see the
  // module-level comment for why this is FK-load-bearing. Duplicate
  // creates throw; we swallow that case (and only that case) because
  // the reconciler runs every minute and most calls hit an existing
  // queue. Any other error propagates to the reconciler's catch so
  // operators see a clear "queue.create_failed" trail.
  try {
    await opts.boss.createQueue(opts.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists|duplicate key value/i.test(msg)) {
      logger.warn({
        module: "scheduler",
        action: "queue.create_failed",
        msg: "could not ensure pg-boss queue for scheduled binding",
        queue: opts.name,
        error: msg,
      });
      throw err;
    }
  }
  await opts.boss.schedule(opts.name, opts.cron, opts.payload ?? null, {
    ...(opts.tz ? { tz: opts.tz } : {}),
  });
}

export async function unscheduleCron(boss: PgBoss, name: string): Promise<void> {
  try {
    await boss.unschedule(name);
  } catch {
    /* ignore — schedule may never have existed */
  }
}
