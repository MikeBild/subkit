// Shared `mcp_tasks` row helpers + the terminal CallToolResult
// envelope shape for the MCP async-Tasks path (SEP-1686).
//
// Every query here is tenant-scoped — `mcp_tasks` rows are addressed by
// (tenant_id, id) so a foreign tenant cannot read or mutate another
// tenant's task even when it guesses a valid taskId.

import { and, desc, eq, sql } from "drizzle-orm";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { mcpTasks } from "../../db/schema/index.ts";

/**
 * The terminal payload a `conversation.run-turn` worker writes into
 * `mcp_tasks.result` on a successful turn. This is the CallToolResult
 * the client ultimately fetches via `tasks/result` (or `conversation_get`
 * for a non-Tasks client).
 */
export interface ConversationTurnEnvelope {
  conversation_id: string;
  status: "active" | "awaiting_input" | "committed" | "abandoned" | "exhausted";
  events: unknown[];
  pending_elicitation_id?: string;
  committed_workflow_id?: string;
}

export interface InsertMcpTaskParams {
  tenant_id: string;
  conversation_id: string;
  kind: "start" | "append" | "respond_elicitation";
  actor_id: string | null;
  request_source: string;
  /**
   * The exact `conversation_messages` user row this turn runs on. The
   * handler persists the user message first, then passes its id here so
   * the worker reads THAT row by id (never MAX(created_at)). Null for
   * `respond_elicitation` turns — they carry no new user message.
   */
  user_message_id: string | null;
}

export interface McpTaskRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  turn_seq: number;
  kind: "start" | "append" | "respond_elicitation";
  job_id: string | null;
  actor_id: string | null;
  user_message_id: string | null;
  result: ConversationTurnEnvelope | null;
  failure_reason: string | null;
  cancelled_at: Date | null;
  created_at: Date;
}

/**
 * Insert a fresh `mcp_tasks` index row. `turn_seq` is computed as
 * `max(turn_seq)+1` for the conversation inside the same statement so
 * concurrent inserts can't collide on the sequence. Returns the new
 * row id (= the MCP taskId).
 */
export async function insertMcpTask(p: InsertMcpTaskParams, db: Db): Promise<string> {
  const [row] = await db
    .insert(mcpTasks)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      kind: p.kind,
      actor_id: p.actor_id,
      request_source: p.request_source,
      user_message_id: p.user_message_id,
      // max(turn_seq)+1 for this conversation, computed in-statement.
      turn_seq: sql<number>`(
        SELECT COALESCE(MAX(${mcpTasks.turn_seq}), 0) + 1
        FROM ${mcpTasks}
        WHERE ${mcpTasks.tenant_id} = ${p.tenant_id}
          AND ${mcpTasks.conversation_id} = ${p.conversation_id}
      )`,
    })
    .returning({ id: mcpTasks.id });
  assertInsertRow(row, "mcp_tasks");
  return row.id;
}

/** Record the pg-boss job id once the `conversation.run-turn` job is enqueued. */
export async function setMcpTaskJobId(
  tenant_id: string,
  task_id: string,
  job_id: string,
  db: Db,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ job_id, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

/** Tenant-scoped read of a single task row. */
export async function getMcpTask(
  tenant_id: string,
  task_id: string,
  db: Db,
): Promise<McpTaskRow | null> {
  const [row] = await db
    .select()
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)))
    .limit(1);
  return row ? (row as McpTaskRow) : null;
}

/** Worker success path — persist the terminal CallToolResult envelope. */
export async function setMcpTaskResult(
  tenant_id: string,
  task_id: string,
  result: ConversationTurnEnvelope,
  db: Db,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ result, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

/** Worker failure path — persist the machine-readable failure code. */
export async function setMcpTaskFailure(
  tenant_id: string,
  task_id: string,
  failure_reason: string,
  db: Db,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ failure_reason, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

/**
 * Mark a task `failed` ONLY when it is not already terminal. Used by
 * the `conversation.run-turn.dlq` consumer: a worker that crashed
 * mid-turn left no terminal column, but a worker that DID write
 * `result` / `failure_reason` / `cancelled_at` before the process
 * died (or a redelivered DLQ job) must not be clobbered. Returns true
 * when this call was the one that stamped the failure.
 */
export async function setMcpTaskFailureIfNotTerminal(
  tenant_id: string,
  task_id: string,
  failure_reason: string,
  db: Db,
): Promise<boolean> {
  const rows = await db
    .update(mcpTasks)
    .set({ failure_reason, updated_at: new Date() })
    .where(
      and(
        eq(mcpTasks.tenant_id, tenant_id),
        eq(mcpTasks.id, task_id),
        sql`${mcpTasks.result} IS NULL`,
        sql`${mcpTasks.failure_reason} IS NULL`,
        sql`${mcpTasks.cancelled_at} IS NULL`,
      ),
    )
    .returning({ id: mcpTasks.id });
  return rows.length > 0;
}

/** `tasks/cancel` path — stamp `cancelled_at`. Idempotent. */
export async function setMcpTaskCancelled(
  tenant_id: string,
  task_id: string,
  db: Db,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ cancelled_at: new Date(), updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

/**
 * The most recent `mcp_tasks` row for a conversation — highest
 * `turn_seq`. Tenant-scoped. Backs the `conversation_get` poll tool.
 */
export async function latestMcpTaskForConversation(
  tenant_id: string,
  conversation_id: string,
  db: Db,
): Promise<McpTaskRow | null> {
  const [row] = await db
    .select()
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.conversation_id, conversation_id)))
    .orderBy(desc(mcpTasks.turn_seq))
    .limit(1);
  return row ? (row as McpTaskRow) : null;
}

/**
 * The highest `turn_seq` among a conversation's `mcp_tasks` rows, or
 * `null` when the conversation has none. Lets `deriveTask` tell a
 * historical (non-latest) task apart from the live one: only the
 * latest-`turn_seq` row may flip to `input_required` off a conversation
 * that paused — an older completed task derives purely from its own
 * `result` / `failure_reason` / `cancelled_at`, so a LATER turn pausing
 * does not retroactively un-complete it.
 */
export async function maxTurnSeqForConversation(
  tenant_id: string,
  conversation_id: string,
  db: Db,
): Promise<number | null> {
  const [row] = await db
    .select({ turn_seq: mcpTasks.turn_seq })
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.conversation_id, conversation_id)))
    .orderBy(desc(mcpTasks.turn_seq))
    .limit(1);
  return row ? row.turn_seq : null;
}

/** Tenant-scoped paginated list, newest first. */
export async function listMcpTasks(
  tenant_id: string,
  db: Db,
  opts?: { limit?: number; offset?: number },
): Promise<McpTaskRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const offset = Math.max(opts?.offset ?? 0, 0);
  const rows = await db
    .select()
    .from(mcpTasks)
    .where(eq(mcpTasks.tenant_id, tenant_id))
    .orderBy(desc(mcpTasks.created_at))
    .limit(limit)
    .offset(offset);
  return rows as McpTaskRow[];
}
