import { and, eq, isNull } from "drizzle-orm";
import { type Executor, workflows } from "../../db/index.ts";

export async function findApprovalSubjectWorkflow(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
) {
  const [current] = await db
    .select({ name: workflows.name, slug: workflows.slug })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  return current ?? null;
}
