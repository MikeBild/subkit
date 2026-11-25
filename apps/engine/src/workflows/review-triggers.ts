import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { withTenantScope } from "../db/index.ts";
import { webhooksInbound, workflowsSchedules } from "../db/schema/index.ts";

interface ReviewTriggerState {
  id: string;
  kind: "schedule" | "webhook";
  name: string;
  cron?: string;
  timezone?: string;
  active: boolean;
  execution_mode: "dev" | "prod";
  admission_hold: unknown;
  updated_at: string;
}

export async function readReviewTriggerState(
  tenant_id: string,
  workflow_id: string | null,
  db: Executor,
  lock = false,
): Promise<ReviewTriggerState[]> {
  if (!workflow_id) return [];
  const schedulesQuery = db
    .select()
    .from(workflowsSchedules)
    .where(
      and(
        eq(workflowsSchedules.tenant_id, tenant_id),
        eq(workflowsSchedules.workflow_id, workflow_id),
      ),
    )
    .orderBy(workflowsSchedules.id);
  const schedules = lock ? await schedulesQuery.for("update") : await schedulesQuery;
  const webhooks = await withTenantScope(db, tenant_id, async (tx) => {
    const webhooksQuery = tx
      .select()
      .from(webhooksInbound)
      .where(
        and(eq(webhooksInbound.tenant_id, tenant_id), eq(webhooksInbound.workflow_id, workflow_id)),
      )
      .orderBy(webhooksInbound.id);
    return lock ? await webhooksQuery.for("update") : await webhooksQuery;
  });
  return [
    ...schedules.map((row) => ({
      id: row.id,
      kind: "schedule" as const,
      name: "Existing schedule",
      cron: row.cron,
      timezone: row.timezone,
      active: !row.paused,
      execution_mode: row.execution_mode,
      admission_hold: row.admission_hold,
      updated_at: row.updated_at.toISOString(),
    })),
    ...webhooks.map((row) => ({
      id: row.id,
      kind: "webhook" as const,
      name: row.slug,
      active: row.active,
      execution_mode: "prod" as const,
      admission_hold: row.admission_hold,
      updated_at: row.updated_at.toISOString(),
    })),
  ];
}
