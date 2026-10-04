import { and, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { workflows } from "../db/schema/index.ts";

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
