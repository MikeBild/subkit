import { CronExpressionParser } from "cron-parser";
import { AUTHORITY_WINDOW_MAX_DAYS, DAY_MS } from "./core/authority.ts";

const AUTOMATIC_WINDOW_DAYS = AUTHORITY_WINDOW_MAX_DAYS - 1;
const MAX_RUNS = 10_000;
export const HOOK_RUN_HEADROOM = 2;
export const HOOK_MINIMUM_RUNS = 100;

export interface HookDeliveryRate {
  deliveries: number;
  window_days: number;
}

export type AuthoritySuggestionBasis =
  | { kind: "manual" }
  | { kind: "schedule"; scheduled_runs: number }
  | {
      kind: "hook";
      scheduled_runs: number;
      observed_deliveries: number;
      observed_days: number;
      minimum_applied: boolean;
    };

function scheduledRuns(
  now: Date,
  until: number,
  schedules: readonly { cron: string; timezone: string }[],
): number {
  const from = now.getTime();
  let runs = 0;
  for (const schedule of schedules) {
    const every = /^every:(\d+(?:\.\d+)?)$/.exec(schedule.cron);
    if (every) {
      const seconds = Number(every[1]);
      if (seconds > 0) runs += Math.ceil((until - from) / (seconds * 1000));
    } else {
      try {
        const iterator = CronExpressionParser.parse(schedule.cron, {
          currentDate: now,
          tz: schedule.timezone,
        });
        while (runs < MAX_RUNS && iterator.next().getTime() < until) runs++;
      } catch {}
    }
    if (runs >= MAX_RUNS) break;
  }
  return runs;
}

export function suggestAuthorityBounds(
  now: Date,
  schedules: readonly { cron: string; timezone: string }[],
  hooks: HookDeliveryRate | null = null,
) {
  const from = now.getTime();
  const automatic = schedules.length > 0 || hooks !== null;
  const until = from + (automatic ? AUTOMATIC_WINDOW_DAYS : 1) * DAY_MS;
  const scheduled = scheduledRuns(now, until, schedules);
  let runs = scheduled;
  let basis: AuthoritySuggestionBasis =
    schedules.length > 0 ? { kind: "schedule", scheduled_runs: scheduled } : { kind: "manual" };
  if (hooks) {
    const projected =
      hooks.window_days > 0
        ? Math.ceil(
            (hooks.deliveries / hooks.window_days) * AUTOMATIC_WINDOW_DAYS * HOOK_RUN_HEADROOM,
          )
        : 0;
    runs += Math.max(HOOK_MINIMUM_RUNS, projected);
    basis = {
      kind: "hook",
      scheduled_runs: scheduled,
      observed_deliveries: hooks.deliveries,
      observed_days: hooks.window_days,
      minimum_applied: projected < HOOK_MINIMUM_RUNS,
    };
  }
  return {
    valid_from: now.toISOString(),
    valid_until: new Date(until).toISOString(),
    max_runs: Math.max(1, Math.min(MAX_RUNS, runs)),
    basis,
  };
}
