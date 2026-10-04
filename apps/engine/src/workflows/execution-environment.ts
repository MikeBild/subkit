import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { webhooksInbound, workflowsSchedules } from "../db/schema/index.ts";

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
  const [hook] = await db
    .select({ id: webhooksInbound.id })
    .from(webhooksInbound)
    .where(
      and(
        eq(webhooksInbound.tenant_id, tenant_id),
        eq(webhooksInbound.workflow_id, workflow_id),
        eq(webhooksInbound.active, true),
      ),
    )
    .limit(1);
  const environments = [
    ...new Set<"dev" | "prod">([
      ...schedules.map((schedule) => schedule.environment),
      ...(hook ? (["prod"] as const) : []),
    ]),
  ];
  if (environments.length > 1)
    throw Object.assign(
      new Error(
        "This workflow is started in multiple environments. Choose the intended environment before preparing a run.",
      ),
      { code: "workflow_environment_ambiguous" },
    );
  return environments[0] ?? "dev";
}
