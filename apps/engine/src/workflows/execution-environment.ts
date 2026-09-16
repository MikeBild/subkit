import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflowsSchedules } from "../db/schema/index.ts";

/** Saved workflow tools follow their configured schedule, never a hardcoded dev credential. */
export async function workflowExecutionEnvironment(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<"dev" | "prod"> {
  const schedules = await db
    .select({ environment: workflowsSchedules.execution_mode })
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
        eq(workflowsSchedules.paused, false),
      ),
    );
  const environments = [...new Set(schedules.map((schedule) => schedule.environment))];
  if (environments.length > 1)
    throw Object.assign(
      new Error(
        "This workflow has schedules in multiple environments. Choose the intended environment before preparing a run.",
      ),
      { code: "workflow_environment_ambiguous" },
    );
  return environments[0] ?? "dev";
}
