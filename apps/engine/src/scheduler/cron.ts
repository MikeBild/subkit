// Thin wrapper over pg-boss schedule / unschedule plus cron expression
// validation. pg-boss only supports 5-field cron expressions (minute
// resolution). For tests we also accept an `every:N` shorthand that
// means "fire every N seconds" and is implemented process-locally via
// `setInterval` instead of via pg-boss' cron.

import { CronExpressionParser } from "cron-parser";
import type { PgBoss } from "pg-boss";

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
