import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Actor } from "../../audit/actor.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db, Executor } from "../../db/client.ts";
import { conversationToolCalls, mcpTasks } from "../../db/schema/index.ts";

export interface ConversationTurnEnvelope {
  turn_id?: string;
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
  actor: Actor | null;
  request_source: string;
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
  actor_kind: "user" | "system_account" | null;
  request_source: string;
  user_message_id: string | null;
  result: ConversationTurnEnvelope | null;
  failure_reason: string | null;
  cancelled_at: Date | null;
  phase: string | null;
  last_action: string | null;
  progress_step: string | null;
  heartbeat_at: Date | null;
  parked_until: Date | null;
  parked_reason: string | null;
  created_at: Date;
}

export async function insertMcpTask(p: InsertMcpTaskParams, db: Db): Promise<string> {
  const [row] = await db
    .insert(mcpTasks)
    .values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      kind: p.kind,
      actor_id: p.actor?.id ?? null,
      actor_kind: p.actor?.kind ?? null,
      request_source: p.request_source,
      user_message_id: p.user_message_id,
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

export async function rearmMcpTaskForNativeElicitation(
  p: { tenant_id: string; task_id: string; actor: Actor | null },
  db: Db,
): Promise<boolean> {
  const rows = await db
    .update(mcpTasks)
    .set({
      kind: "respond_elicitation",
      actor_id: p.actor?.id ?? null,
      actor_kind: p.actor?.kind ?? null,
      user_message_id: null,
      job_id: null,
      result: null,
      failure_reason: null,
      cancelled_at: null,
      phase: "awaiting_human_input",
      last_action: "elicitation/create",
      progress_step: null,
      heartbeat_at: new Date(),
      updated_at: new Date(),
    })
    .where(and(eq(mcpTasks.tenant_id, p.tenant_id), eq(mcpTasks.id, p.task_id)))
    .returning({ id: mcpTasks.id });
  return rows.length === 1;
}

export async function getMcpTask(
  tenant_id: string,
  task_id: string,
  db: Executor,
): Promise<McpTaskRow | null> {
  const [row] = await db
    .select()
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)))
    .limit(1);
  return row ? (row as McpTaskRow) : null;
}

export async function setMcpTaskResult(
  tenant_id: string,
  task_id: string,
  result: ConversationTurnEnvelope,
  db: Executor,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ result, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

export async function setMcpTaskResultIfCurrentAttempt(
  tenant_id: string,
  task_id: string,
  attempt_id: string,
  result: ConversationTurnEnvelope,
  db: Executor,
): Promise<boolean> {
  const rows = await db
    .update(mcpTasks)
    .set({ result, updated_at: new Date() })
    .where(
      and(
        eq(mcpTasks.tenant_id, tenant_id),
        eq(mcpTasks.id, task_id),
        eq(mcpTasks.job_id, attempt_id),
      ),
    )
    .returning({ id: mcpTasks.id });
  return rows.length === 1;
}

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

export async function setMcpTaskFailureIfNotTerminal(
  tenant_id: string,
  task_id: string,
  failure_reason: string,
  db: Executor,
  expected_attempt_id?: string,
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
        ...(expected_attempt_id ? [eq(mcpTasks.job_id, expected_attempt_id)] : []),
      ),
    )
    .returning({ id: mcpTasks.id });
  return rows.length > 0;
}

export async function laterTurnCompleted(
  tenant_id: string,
  conversation_id: string,
  turn_seq: number,
  db: Executor,
): Promise<boolean> {
  const [row] = await db
    .select({ id: mcpTasks.id })
    .from(mcpTasks)
    .where(
      and(
        eq(mcpTasks.tenant_id, tenant_id),
        eq(mcpTasks.conversation_id, conversation_id),
        gt(mcpTasks.turn_seq, turn_seq),
        sql`${mcpTasks.result} IS NOT NULL`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function setMcpTaskCancelled(
  tenant_id: string,
  task_id: string,
  db: Db,
): Promise<boolean> {
  const rows = await db
    .update(mcpTasks)
    .set({ cancelled_at: new Date(), updated_at: new Date() })
    .where(
      and(
        eq(mcpTasks.tenant_id, tenant_id),
        eq(mcpTasks.id, task_id),
        sql`${mcpTasks.cancelled_at} IS NULL`,
      ),
    )
    .returning({ id: mcpTasks.id });
  return rows.length > 0;
}

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
  if (tool === "author_workflow") return "building";
  if (tool === "edit_workflow_patch") return "editing";
  return "working";
}

function stepFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.step_id === "string") return o.step_id;
  if (typeof o.id === "string") return o.id;
  return null;
}

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
  last_action: string;
  phase: string;
  step: string | null;
  created_at: Date;
}

export async function setMcpTaskParked(
  tenant_id: string,
  task_id: string,
  parked_until: Date,
  parked_reason: string,
  db: Db,
): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ parked_until, parked_reason, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

export async function clearMcpTaskPark(tenant_id: string, task_id: string, db: Db): Promise<void> {
  await db
    .update(mcpTasks)
    .set({ parked_until: null, parked_reason: null, updated_at: new Date() })
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));
}

export async function parkedStateForConversation(
  tenant_id: string,
  conversation_id: string,
  db: Db,
): Promise<{ parked_until: Date; parked_reason: string | null } | null> {
  const [row] = await db
    .select({
      parked_until: mcpTasks.parked_until,
      parked_reason: mcpTasks.parked_reason,
      result: mcpTasks.result,
      failure_reason: mcpTasks.failure_reason,
      cancelled_at: mcpTasks.cancelled_at,
    })
    .from(mcpTasks)
    .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.conversation_id, conversation_id)))
    .orderBy(desc(mcpTasks.turn_seq))
    .limit(1);
  if (!row || row.result || row.failure_reason || row.cancelled_at) return null;
  if (!row.parked_until || row.parked_until.getTime() <= Date.now()) return null;
  return { parked_until: row.parked_until, parked_reason: row.parked_reason };
}

export async function latestProgressForConversation(
  tenant_id: string,
  conversation_id: string,
  db: Db,
): Promise<ConversationProgress | null> {
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
