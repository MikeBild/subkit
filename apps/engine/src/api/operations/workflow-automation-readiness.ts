import type { Executor } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import { inspectAutomationReadiness } from "../../workflows/automation-readiness.ts";
import type { WorkflowView } from "../../workflows/view.ts";

export async function automationReadinessFor(
  db: Executor,
  tenant_id: string,
  workflow: WorkflowView | null,
  source: "schedule_write" | "workflow_save",
  environment?: "dev" | "prod",
) {
  if (!workflow) return undefined;
  const readiness = await inspectAutomationReadiness(db, tenant_id, workflow, environment);
  if (readiness.state !== "eligible")
    logger.info({
      module: "http",
      action: "automation_readiness.not_eligible",
      tenant_id,
      workflow_id: workflow.id,
      source,
      environment: readiness.environment,
      state: readiness.state,
      issue_codes: readiness.issues.map((issue) => `${issue.step_id}:${issue.code}`),
    });
  return readiness;
}
