import { CronExpressionParser } from "cron-parser";

interface CronValidationResult {
  ok: boolean;
  reason?: string;
  mode: "cron" | "every";
  everySeconds?: number;
}

const EVERY_PREFIX = "every:";
const EVERY_SECONDS_PATTERN = /^\d+(?:\.\d+)?$/;

function parseEverySeconds(rest: string): number | null {
  const trimmedRest = rest.trim();
  if (!EVERY_SECONDS_PATTERN.test(trimmedRest)) return null;
  const seconds = Number(trimmedRest);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function parseCronExpression(expr: string): CronValidationResult {
  const trimmed = expr.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) {
    const everySeconds = parseEverySeconds(trimmed.slice(EVERY_PREFIX.length));
    if (everySeconds === null) {
      return { ok: false, mode: "every", reason: `invalid every expression: ${expr}` };
    }
    return { ok: true, mode: "every", everySeconds };
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
  if (trimmed.startsWith(EVERY_PREFIX)) {
    const seconds = parseEverySeconds(trimmed.slice(EVERY_PREFIX.length));
    if (seconds === null) return false;
    if (!lastFiredAt) return true;
    return now.getTime() - lastFiredAt.getTime() >= seconds * 1000;
  }
  if (!lastFiredAt) return true;
  const next = nextCronOccurrence(trimmed, lastFiredAt, tz);
  return next !== null && now.getTime() >= next.getTime();
}

export function cronOccurrencesWithin(
  cron: string,
  from: Date,
  to: Date,
  tz: string | undefined,
  cap: number,
): Date[] {
  const trimmed = cron.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) return [];
  const found: Date[] = [];
  try {
    const iterator = CronExpressionParser.parse(trimmed, {
      currentDate: from,
      endDate: to,
      strict: false,
      ...(tz ? { tz } : {}),
    });
    while (found.length < cap && iterator.hasNext()) found.push(iterator.next().toDate());
  } catch {
    return found;
  }
  return found;
}

export interface CronDayPlan {
  startMinutes: number[];
  firesOnDay: (utcMidnight: number) => boolean;
}

export function cronDayPlan(cron: string): CronDayPlan | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith(EVERY_PREFIX)) return null;
  try {
    const expression = CronExpressionParser.parse(trimmed, { strict: false, tz: "UTC" });
    const { hour, minute } = expression.fields;
    const startMinutes = hour.values
      .flatMap((startHour) => minute.values.map((startMinute) => startHour * 60 + startMinute))
      .sort((left, right) => left - right);
    const firstStartMs = (startMinutes[0] ?? 0) * 60_000;
    return {
      startMinutes,
      firesOnDay: (utcMidnight) => expression.includesDate(new Date(utcMidnight + firstStartMs)),
    };
  } catch {
    return null;
  }
}
