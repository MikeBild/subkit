import { CronExpressionParser } from "cron-parser";
import type { Executor } from "../db/client.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";
import { listSchedules } from "./repo.ts";

export function nextScheduleTime(cron: string, timezone: string, now: Date): string | null {
  if (cron.startsWith("every:")) return null;
  try {
    return CronExpressionParser.parse(cron, { currentDate: now, tz: timezone, strict: false })
      .next()
      .toDate()
      .toISOString();
  } catch {
    return null;
  }
}
export async function workflowAutomationView(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
) {
  const schedules = (await listSchedules(db, tenant, workflow)).rows;
  return Promise.all(
    schedules.map(async (schedule) => ({
      ...(await inspectScheduleAutomation(schedule, db)),
      cron: schedule.cron,
      timezone: schedule.timezone,
      environment: schedule.execution_mode,
      next_run_at: schedule.paused ? null : nextScheduleTime(schedule.cron, schedule.timezone, now),
    })),
  );
}
