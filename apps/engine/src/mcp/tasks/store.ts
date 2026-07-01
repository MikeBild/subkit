// Shared `mcp_tasks` row helpers + the terminal CallToolResult
// envelope shape for the MCP async-Tasks path (SEP-1686).
//
// Every query here is tenant-scoped — `mcp_tasks` rows are addressed by
// (tenant_id, id) so a foreign tenant cannot read or mutate another
// tenant's task even when it guesses a valid taskId.
//
// TODO(mcp-spec): the forthcoming stateless-core MCP revision graduates Tasks
// from an experimental core feature to an extension and REDESIGNS the API —
// driven by tasks/get|update|cancel with self-contained requests, replacing
// the current result-blocking `tasks/result` shape this store backs. Migrate
// when @modelcontextprotocol/sdk ships the new surface. Same revision drops
// the initialize/Mcp-Session-Id handshake for a stateless core (server→client
// work via InputRequiredResult + client retry with requestState) — that would
// let subkit retire the SSE-held-stream elicitation/confirm-gate machinery at
// the root. Until the SDK lands it, do not add new session-state dependencies.

import { and, desc, eq, sql } from "drizzle-orm";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db } from "../../db/client.ts";
import { conversationToolCalls, mcpTasks } from "../../db/schema/index.ts";

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
  // Worker-stamped progress heartbeat (Option-B). Null until the worker
  // stamps the first tool, or on a legacy in-flight row predating the
  // columns — the read side falls back to the tool-call derivation.
  phase: string | null;
  last_action: string | null;
  progress_step: string | null;
  heartbeat_at: Date | null;
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

/**
 * A coarse authoring phase derived purely from the newest tool call's
 * tool name — read-side, no schema column. Lets a poll client
 * (ChatGPT / claude.ai) show "building" vs "validating" vs "committing"
 * instead of a bare spinner, so a 30-60s background turn reads as
 * progress rather than a hang.
 */
function phaseForTool(tool: string): string {
  if (tool.startsWith("ask_user")) return "awaiting_input";
  if (
    tool === "dry_run_workflow" ||
    tool === "dry_run_step" ||
    tool === "validate_draft" ||
    tool === "inspect_workflow" ||
    tool === "inspect_workflow_draft"
  ) {
    return "validating";
  }
  if (tool === "save_workflow_draft" || tool === "save_connector_draft") return "committing";
  if (tool === "run_workflow") return "running";
  // The authoring pipeline collapsed to two write tools:
  // `author_workflow` builds the complete draft in one call, and
  // `edit_workflow_patch` is the repair-stage editor. The retired
  // `build_/propose_/update_` micro-tools no longer exist, so a prefix
  // bucket would only ever match dead names — map the live tools
  // explicitly instead so a long authoring turn reports honest progress.
  if (tool === "author_workflow") return "building";
  if (tool === "edit_workflow_patch") return "editing";
  return "working";
}

/**
 * The workflow step a tool call targeted, read off its raw input. Mirrors
 * the `latestProgressForConversation` fallback: `step_id` first, else the
 * generic `id`. Null when the input carries neither.
 */
function stepFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.step_id === "string") return o.step_id;
  if (typeof o.id === "string") return o.id;
  return null;
}

/**
 * Option-B worker stamp. Called from the conversation loop's tool-record
 * chokepoint as each authoring tool starts, so the LIVE (highest
 * `turn_seq`) `mcp_tasks` row for the conversation carries an accurate,
 * monotonic progress heartbeat that `conversation_get` reads directly —
 * instead of re-deriving phase from the newest `conversation_tool_calls`
 * row at read time (which lags tool granularity and can't reflect
 * mid-tool progress).
 *
 * Tenant-scoped. Targets only the highest-`turn_seq` row and only while
 * it is non-terminal (no `result` / `failure_reason` / `cancelled_at`),
 * so a stamp arriving after the worker already wrote a terminal column
 * can't resurrect a settled task. A conversation with no `mcp_tasks` row
 * (an inline sk-REPL turn) matches nothing — the update is a harmless
 * no-op.
 */
export async function stampMcpTaskProgress(
  tenant_id: string,
  conversation_id: string,
  tool: string,
  input: unknown,
  db: Db,
): Promise<void> {
  const now = new Date();
  await db
    .update(mcpTasks)
    .set({
      phase: phaseForTool(tool),
      last_action: tool,
      progress_step: stepFromInput(input),
      heartbeat_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(mcpTasks.tenant_id, tenant_id),
        // Only the live turn — the highest-`turn_seq` row for this
        // conversation. A correlated subquery on the same table (the
        // proven `insertMcpTask` pattern) resolves the target id.
        sql`${mcpTasks.id} = (
          SELECT id FROM ${mcpTasks}
          WHERE ${mcpTasks.tenant_id} = ${tenant_id}
            AND ${mcpTasks.conversation_id} = ${conversation_id}
          ORDER BY ${mcpTasks.turn_seq} DESC
          LIMIT 1
        )`,
        sql`${mcpTasks.result} IS NULL`,
        sql`${mcpTasks.failure_reason} IS NULL`,
        sql`${mcpTasks.cancelled_at} IS NULL`,
      ),
    );
}

export interface ConversationProgress {
  /** The tool name of the newest `conversation_tool_calls` row. */
  last_action: string;
  /** Coarse authoring phase derived from `last_action`. */
  phase: string;
  /** The step id the last action targeted, when the input carries one. */
  step: string | null;
  created_at: Date;
}

/**
 * The working-state heartbeat for a conversation. Backs the
 * `conversation_get` poll tool so a client can tell an actively-building
 * turn from a hung one. Tenant-scoped. Null-safe.
 *
 * Option-B: the AUTHORITATIVE source is the worker-stamped `mcp_tasks`
 * row (highest `turn_seq`) — accurate, monotonic progress independent of
 * `conversation_tool_calls` granularity. Only when that row carries no
 * stamp (an in-flight turn that hasn't run its first tool, or a legacy
 * row created before the columns existed) does it fall back to deriving
 * phase/last_action from the newest `conversation_tool_calls` row.
 */
export async function latestProgressForConversation(
  tenant_id: string,
  conversation_id: string,
  db: Db,
): Promise<ConversationProgress | null> {
  // 1) Authoritative: the worker-stamped live task row.
  const [stamped] = await db
    .select({
      phase: mcpTasks.phase,
      last_action: mcpTasks.last_action,
      progress_step: mcpTasks.progress_step,
      heartbeat_at: mcpTasks.heartbeat_at,
    })
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.conversation_id, conversation_id)))
    .orderBy(desc(mcpTasks.turn_seq))
    .limit(1);
  if (stamped?.phase && stamped.last_action) {
    return {
      last_action: stamped.last_action,
      phase: stamped.phase,
      step: stamped.progress_step ?? null,
      created_at: stamped.heartbeat_at ?? new Date(),
    };
  }

  // 2) Fallback: derive from the newest `conversation_tool_calls` row.
  const [row] = await db
    .select({
      tool: conversationToolCalls.tool,
      input: conversationToolCalls.input,
      created_at: conversationToolCalls.created_at,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
      ),
    )
    .orderBy(desc(conversationToolCalls.created_at))
    .limit(1);
  if (!row) return null;
  const input =
    row.input && typeof row.input === "object" ? (row.input as Record<string, unknown>) : null;
  const step =
    input && typeof input.step_id === "string"
      ? input.step_id
      : input && typeof input.id === "string"
        ? input.id
        : null;
  return {
    last_action: row.tool,
    phase: phaseForTool(row.tool),
    step,
    created_at: row.created_at,
  };
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
