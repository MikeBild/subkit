import { CronExpressionParser } from "cron-parser";

const DAY_MS = 86_400_000;
/** The window suggested for anything that starts runs without a person. */
const AUTOMATIC_WINDOW_DAYS = 30;
const MAX_RUNS = 10_000;
/**
 * A hook's deliveries arrive in bursts a short observation does not show, so
 * the projection is doubled, and a hook that was barely called still gets
 * room for a few calls a day rather than a window it exhausts by noon.
 */
export const HOOK_RUN_HEADROOM = 2;
export const HOOK_MINIMUM_RUNS = 100;

/**
 * The deliveries a workflow's inbound hooks verified over the last
 * `window_days` — started runs and deliveries the approval gate refused.
 */
export interface HookDeliveryRate {
  deliveries: number;
  window_days: number;
}

/** Where a suggestion comes from, so a surface can explain it in one line. */
export type AuthoritySuggestionBasis =
  /** Nothing starts it automatically: one run, one day. */
  | { kind: "manual" }
  /** The schedules' own occurrences over the window. */
  | { kind: "schedule"; scheduled_runs: number }
  /**
   * The hooks' recent delivery rate, projected over the window with headroom.
   * `minimum_applied`: the projection was below the floor and the floor stands.
   */
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
      } catch {
        // Invalid stored schedules do not create additional authority.
      }
    }
    if (runs >= MAX_RUNS) break;
  }
  return runs;
}

/**
 * Suggestions are inert; the human still approves the displayed finite limits.
 *
 * `hooks` is the delivery rate of the workflow's active inbound hooks, or null
 * when none delivers in the reviewed environment. A hook-started workflow used
 * to get the manual default — one run in 24 hours — which its second delivery
 * already exhausted.
 */
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
