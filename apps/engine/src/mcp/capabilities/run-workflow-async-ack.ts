import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executions } from "../../db/schema/index.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";

/**
 * Discover the execution a backgrounded `run_workflow` call kicked off, so
 * the tools/call response can return an async-ack poll handle (mirroring the
 * `wf_<slug>` path) instead of a bare `engine_busy` when the run outlives the
 * inline deadline. Scoped to executions created at/after the call started so a
 * prior run of the same workflow is never mistaken for this one. Returns null
 * when the workflow reference can't be resolved (e.g. a conversation-bound
 * active target with no explicit `workflow` arg) — the caller then falls back
 * to `engine_busy`.
 */
export async function findBackgroundExecutionId(opts: {
  db: Db;
  tenant_id: string;
  workflowRef: string | undefined;
  since: number;
}): Promise<string | null> {
  const { db, tenant_id, workflowRef, since } = opts;
  if (!workflowRef) return null;
  const wf = await resolveWorkflowByIdOrSlug(db, tenant_id, workflowRef, {
    require_published: true,
  });
  if (!wf) return null;
  try {
    const rows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, tenant_id),
          eq(executions.workflow_id, wf.id),
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
