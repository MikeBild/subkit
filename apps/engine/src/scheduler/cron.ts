import { CronExpressionParser } from "cron-parser";

interface CronValidationResult {
  ok: boolean;
  reason?: string;
  mode: "cron" | "every";
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

export function previousCronOccurrence(cron: string, atOrBefore: Date, tz?: string): Date | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) return null;
  try {
    return CronExpressionParser.parse(trimmed, {
      currentDate: new Date(atOrBefore.getTime() + 1),
      strict: false,
      ...(tz ? { tz } : {}),
    })
      .prev()
      .toDate();
  } catch {
    return null;
  }
}

export function isCronDue(cron: string, lastFiredAt: Date | null, now: Date, tz?: string): boolean {
  const trimmed = cron.trim();
  if (trimmed.startsWith("every:")) {
    const seconds = Number.parseFloat(trimmed.slice("every:".length));
    if (!Number.isFinite(seconds) || seconds <= 0) return false;
    if (!lastFiredAt) return true;
    return now.getTime() - lastFiredAt.getTime() >= seconds * 1000;
  }
  if (!lastFiredAt) return true;
  const next = nextCronOccurrence(trimmed, lastFiredAt, tz);
  return next !== null && now.getTime() >= next.getTime();
}
