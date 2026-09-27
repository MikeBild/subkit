// Cron expression validation for workflow schedules. Both cron-mode
// (5-field standard) and the engine's `every:N` shorthand are parsed
// here. Firing is owned entirely by the `SchedulerReconciler` 60s
// in-process poll — cron schedules fire via `reconcileWorkflowSchedules`
// and `every:N` schedules via a local `setInterval`. There is no
// pg-boss-native cron path: a `wf-schedule.*` queue would have no
// registered worker, so jobs scheduled into it would pile up unconsumed.

import { CronExpressionParser } from "cron-parser";

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

/**
 * The first occurrence of a 5-field cron strictly after `after`, in `tz`. The
 * one expansion the reconciler's due check and the published next fire share.
 * Null for an `every:N` expression or an expression the parser rejects.
 */
export function nextCronOccurrence(cron: string, after: Date, tz?: string): Date | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) return null;
  try {
    return CronExpressionParser.parse(trimmed, {
      currentDate: after,
      strict: false,
      ...(tz ? { tz } : {}),
    })
      .next()
      .toDate();
  } catch {
    return null;
  }
}
