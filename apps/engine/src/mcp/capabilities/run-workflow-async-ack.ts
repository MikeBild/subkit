import { and, desc, eq, gte, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversations, executions } from "../../db/schema/index.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";

/**
 * Discover the execution a backgrounded `run_workflow` call kicked off, so
 * the tools/call response can return an async-ack poll handle (mirroring the
 * `wf_<slug>` path) instead of a bare `engine_busy` when the run outlives the
 * inline deadline. Scoped to executions created at/after the call started so a
 * prior run of the same workflow is never mistaken for this one.
 *
 * Resolution mirrors the `run_workflow` tool's OWN resolver exactly (slug or
 * UUID, NO `require_published` filter): the ack must agree with the tool on
 * what "this workflow" means, or a workflow the tool happily ran (e.g. one
 * whose published version was rotated out mid-run) would resolve to null here
 * and orphan a live run into `engine_busy` — the exact failure this handle
 * exists to prevent. Returns null when the reference can't be resolved or no
 * in-window execution exists; the caller then falls back to `engine_busy`.
 */
export async function findBackgroundExecutionId(opts: {
  db: Db;
  tenant_id: string;
  workflowRef: string | undefined;
  since: number;
}): Promise<string | null> {
  const { db, tenant_id, workflowRef, since } = opts;
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

/**
 * Resolve the workflow a `run_workflow` call targeted when the MCP tools/call
 * carried NO explicit `workflow` arg. The tool's precedence is
 * `args.workflow` → the workflow most recently bound to the conversation, so
 * the async-ack path must apply the SAME precedence or a conversation-bound
 * run with no arg orphans into `engine_busy`. Returns the bound
 * `target_workflow_id` of the caller's most-recently-active (non-abandoned)
 * conversation, or null when there is none.
 *
 * Attribution is self-guarding: the caller feeds this id back into
 * `findBackgroundExecutionId`, which STILL filters executions by
 * (workflow_id AND created_at >= since). A wrongly-picked conversation
 * therefore matches no in-window execution and yields null → the caller's
 * honest `engine_busy`, never a cross-workflow false handle. So this can only
 * recover the correct handle; it can never fabricate a wrong one.
 */
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
