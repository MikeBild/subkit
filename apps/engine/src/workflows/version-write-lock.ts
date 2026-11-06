import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { nextVersion, type WorkflowLifecycle, type WorkflowState } from "./core/workflow.ts";

export async function lockWorkflowForVersionWrite(
  tx: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<typeof workflows.$inferSelect | null> {
  const [workflow] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .for("update")
    .limit(1);
  return workflow ?? null;
}

export async function nextVersionNumber(
  tx: Executor,
  tenant_id: string,
  workflow_id: string,
): Promise<number> {
  const [latest] = await tx
    .select({ max: sql<number>`coalesce(max(${workflowVersions.version}), 0)` })
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.workflow_id, workflow_id)),
    );
  return nextVersion([Number(latest?.max ?? 0)]);
}

export function workflowStateOf(row: {
  lifecycle: string;
  current_version_id: string | null;
  draft_version_id: string | null;
}): WorkflowState {
  return {
    lifecycle: row.lifecycle as WorkflowLifecycle,
    current_version_id: row.current_version_id,
    draft_version_id: row.draft_version_id,
  };
}
