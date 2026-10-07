import { and, desc, eq, gte, isNotNull, isNull, ne } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations, executions } from "../../db/schema/index.ts";
import { executionVisibilityFilter } from "../../execution/execution-owner.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";

export async function findBackgroundExecutionId(opts: {
  db: Db;
  tenant_id: string;
  principal: ResolvedPrincipal;
  workflowRef: string | undefined;
  since: number;
}): Promise<string | null> {
  const { db, tenant_id, principal, workflowRef, since } = opts;
  if (!workflowRef) return null;
  const wf = await resolveWorkflowByIdOrSlug(db, tenant_id, workflowRef);
  if (!wf) return null;
  try {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, tenant_id),
          executionVisibilityFilter(principal),
          eq(executions.workflow_id, wf.id),
          isNull(executions.parent_execution_id),
          gte(executions.created_at, new Date(since)),
        ),
      )
      .orderBy(desc(executions.created_at))
      .limit(1);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveConversationBoundWorkflowId(opts: {
  db: Db;
  tenant_id: string;
  owner_id: string;
}): Promise<string | null> {
  const { db, tenant_id, owner_id } = opts;
  try {
    const rows = await db
      .select({ workflow_id: conversations.target_workflow_id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenant_id, tenant_id),
          eq(conversations.owner_id, owner_id),
          ne(conversations.status, "abandoned"),
          isNotNull(conversations.target_workflow_id),
        ),
      )
      .orderBy(desc(conversations.updated_at))
      .limit(1);
    return rows[0]?.workflow_id ?? null;
  } catch {
    return null;
  }
}
