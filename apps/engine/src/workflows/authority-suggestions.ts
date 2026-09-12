import { CronExpressionParser } from "cron-parser";

/** Suggestions are inert; the human still approves the displayed finite limits. */
export function suggestAuthorityBounds(
  now: Date,
  schedules: readonly { cron: string; timezone: string }[],
) {
  const from = now.getTime();
  const until = from + (schedules.length ? 30 : 1) * 86_400_000;
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
        while (runs < 10_000 && iterator.next().getTime() < until) runs++;
      } catch {
        // Invalid stored schedules do not create additional authority.
      }
    }
    if (runs >= 10_000) break;
  }
  return {
    valid_from: now.toISOString(),
    valid_until: new Date(until).toISOString(),
    max_runs: Math.max(1, Math.min(10_000, runs)),
  };
}
