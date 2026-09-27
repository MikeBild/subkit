import type { Executor } from "../db/client.ts";
import { inspectScheduleAutomation } from "./automation-status.ts";
import { nextScheduleFire } from "./next-fire.ts";
import { listSchedules } from "./repo.ts";

export async function workflowAutomationView(
  tenant: string,
  workflow: string,
  db: Executor,
  now: Date,
) {
  const schedules = (await listSchedules(db, tenant, workflow)).rows;
  return Promise.all(
    schedules.map(async (schedule) => {
      const automation = await inspectScheduleAutomation(schedule, db);
      const fires = automation.state !== "paused" && automation.state !== "activation_required";
      return {
        ...automation,
        cron: schedule.cron,
        timezone: schedule.timezone,
        environment: schedule.execution_mode,
        next_run_at: fires ? nextScheduleFire(schedule, now) : null,
      };
    }),
  );
}
