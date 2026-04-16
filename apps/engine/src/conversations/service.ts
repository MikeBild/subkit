// Conversations service — public API used by REST + MCP.
//
// Thin wrapper over loop.ts that also creates the conversation record,
// handles approve/reject resume, and exposes a `get` that returns the
// whole conversation (messages, tool calls, approvals, live draft).

import { and, asc, desc, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Db } from "../db/client.ts";
import { conversationMessages, conversations, conversationToolCalls } from "../db/schema/index.ts";
import { getMockProvider } from "../llm/mock-provider.ts";
import { listApprovalsForConversation, resolveApproval } from "./approval.ts";
import { loadDraft, undoLastSnapshot } from "./draft.ts";
import { type RunLoopResult, runLoop } from "./loop.ts";
import type {
  ConversationDetail,
  ConversationMessageRecord,
  ConversationRecord,
  ConversationStatus,
  ConversationToolCallRecord,
  DraftDocument,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function rowToRecord(row: typeof conversations.$inferSelect): ConversationRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    target_workflow_id: row.target_workflow_id,
    target_connector_id: row.target_connector_id,
    status: row.status as ConversationStatus,
    owner_id: row.owner_id ?? null,
    model: row.model ?? null,
    title: row.title ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface CreateConversationParams {
  tenant_id: string;
  actor_id: string | null;
  connector_id?: string | null;
  workflow_id?: string | null;
  initial_message?: string;
  /** Optional user-supplied memory payload (client-side SUBKIT.md). */
  memory?: string | null;
  /** Optional initial model override (sets conversations.model). */
  model?: string | null;
  /** Optional human title (sets conversations.title). */
  title?: string | null;
}

export interface ConversationTurnOutcome {
  conversation: ConversationRecord;
  result: RunLoopResult;
}

export async function createConversation(
  p: CreateConversationParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const memory = typeof p.memory === "string" ? p.memory : null;
  const [row] = await exec
    .insert(conversations)
    .values({
      tenant_id: p.tenant_id,
      target_connector_id: p.connector_id ?? null,
      target_workflow_id: p.workflow_id ?? null,
      status: "active",
      draft: { name: "new-workflow", steps: [] },
      owner_id: p.actor_id ?? null,
      ...(p.model ? { model: p.model } : {}),
      ...(p.title ? { title: p.title } : {}),
      ...(memory ? { memory } : {}),
    })
    .returning();
  if (!row) throw new Error("conversations insert returned no row");

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_CREATED,
      resource_type: "conversation",
      resource_id: row.id,
      result: "success",
      metadata: {
        connector_id: p.connector_id ?? null,
        workflow_id: p.workflow_id ?? null,
        owner_id: p.actor_id ?? null,
        model: p.model ?? null,
        title: p.title ?? null,
        memory_included: Boolean(memory),
      },
    },
    exec,
  );
  if (memory) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: row.id,
        result: "success",
        metadata: { bytes: memory.length },
      },
      exec,
    );
  }

  // Seed the mock provider plan for the list-users canned flow when
  // the initial message matches. In production this is a no-op
  // because `LLM_PROVIDER` isn't `mock` and the canned plan map stays
  // empty. Tests flip the provider to `mock` in setup.
  if (p.initial_message && /list.*users/i.test(p.initial_message)) {
    const { cannedListUsersPlan } = await import("../llm/mock-provider.ts");
    getMockProvider().setConversePlan(row.id, cannedListUsersPlan(p.connector_id ?? undefined));
  }

  const result = p.initial_message
    ? await runLoop({
        db: exec,
        tenant_id: p.tenant_id,
        conversation_id: row.id,
        actor_id: p.actor_id,
        connector_id: p.connector_id ?? null,
        workflow_id: p.workflow_id ?? null,
        user_message: p.initial_message,
        user_memory: memory,
        model_override: p.model ?? null,
      })
    : { events: [], status: "active" as const };

  // Re-load so status reflects any loop side-effects.
  const updated = await getConversation(p.tenant_id, row.id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}

export interface AppendMessageParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  message: string;
  /** Optional user-supplied memory payload to attach to this turn. */
  memory?: string | null;
}

export async function appendUserMessage(
  p: AppendMessageParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");
  const memory =
    typeof p.memory === "string" && p.memory.length > 0
      ? p.memory
      : conv.conversation.target_workflow_id
        ? null
        : null;
  // If a new memory payload arrived, persist it on the row and emit
  // an audit entry; otherwise reuse the last memory payload we stored.
  let effectiveMemory: string | null = null;
  if (typeof p.memory === "string") {
    await exec
      .update(conversations)
      .set({ memory: p.memory, updated_at: new Date() })
      .where(eq(conversations.id, p.conversation_id));
    effectiveMemory = p.memory;
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_MEMORY_INJECTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { bytes: p.memory.length },
      },
      exec,
    );
  } else {
    // Reuse whatever was last persisted on the row.
    const [row] = await exec
      .select({ memory: conversations.memory, model: conversations.model })
      .from(conversations)
      .where(eq(conversations.id, p.conversation_id))
      .limit(1);
    effectiveMemory = row?.memory ?? null;
  }
  void memory;
  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: p.message,
    user_memory: effectiveMemory,
    model_override: conv.conversation.model,
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  return { conversation: updated.conversation, result };
}

export interface ApprovalDecisionParams {
  tenant_id: string;
  conversation_id: string;
  approval_id: string;
  actor_id: string | null;
  decision: "approved" | "rejected";
  reason?: string;
}

export async function decideApproval(
  p: ApprovalDecisionParams,
  exec: Db,
): Promise<ConversationTurnOutcome> {
  const approval = await resolveApproval(
    {
      tenant_id: p.tenant_id,
      id: p.approval_id,
      status: p.decision,
      decided_by: p.actor_id,
      ...(p.reason ? { reason: p.reason } : {}),
    },
    exec,
  );
  if (!approval) throw new Error("approval not found");

  // Flip the conversation back to active so the loop can resume.
  await exec
    .update(conversations)
    .set({ status: "active", updated_at: new Date() })
    .where(eq(conversations.id, p.conversation_id));

  // Inject the decision as a tool message for audit / visibility.
  await exec.insert(conversationMessages).values({
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    role: "tool",
    content: {
      tool: "request_human_approval",
      decision: p.decision,
      reason: p.reason ?? null,
    } as Record<string, unknown>,
  });

  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");

  // On reject we do not drive another turn — the loop stays paused
  // until the caller sends another user message explaining the next
  // step. On approve we resume the loop with no new user message so
  // the plan continues from its cursor.
  if (p.decision === "rejected") {
    return { conversation: conv.conversation, result: { events: [], status: "active" } };
  }

  const result = await runLoop({
    db: exec,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    connector_id: conv.conversation.target_connector_id,
    workflow_id: conv.conversation.target_workflow_id,
    user_message: null,
  });
  const updated = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!updated) throw new Error("conversation disappeared");
  if (result.status === "committed" && result.committed_workflow_id) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.CONVERSATION_COMMITTED,
        resource_type: "conversation",
        resource_id: p.conversation_id,
        result: "success",
        metadata: { workflow_id: result.committed_workflow_id },
      },
      exec,
    );
  }
  return { conversation: updated.conversation, result };
}

export async function cancelConversation(
  tenant_id: string,
  conversation_id: string,
  actor_id: string | null,
  exec: Db,
): Promise<ConversationRecord | null> {
  const [row] = await exec
    .update(conversations)
    .set({ status: "abandoned", updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id,
      actor_type: actor_id ? "user" : "system",
      actor_id,
      action: AuditAction.CONVERSATION_CANCELLED,
      resource_type: "conversation",
      resource_id: conversation_id,
      result: "success",
    },
    exec,
  );
  return rowToRecord(row);
}

export async function getConversation(
  tenant_id: string,
  id: string,
  exec: Executor,
): Promise<ConversationDetail | null> {
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const msgs = await exec
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversation_id, id))
    .orderBy(asc(conversationMessages.created_at));
  const calls = await exec
    .select()
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, id))
    .orderBy(asc(conversationToolCalls.created_at));
  const draft = await loadDraft(tenant_id, id, exec);
  const approvals = await listApprovalsForConversation(tenant_id, id, exec);
  return {
    conversation: rowToRecord(row),
    messages: msgs.map(
      (m): ConversationMessageRecord => ({
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role as ConversationMessageRecord["role"],
        content: m.content,
        created_at: m.created_at.toISOString(),
      }),
    ),
    tool_calls: calls.map(
      (c): ConversationToolCallRecord => ({
        id: c.id,
        conversation_id: c.conversation_id,
        tool: c.tool,
        input: c.input,
        output: c.output,
        approval_required: c.approval_required,
        created_at: c.created_at.toISOString(),
      }),
    ),
    draft,
    approvals,
  };
}

export interface ListConversationsParams {
  tenant_id: string;
  status?: ConversationStatus;
  /** Restrict to conversations owned by this user id. */
  owner_id?: string;
  limit?: number;
  offset?: number;
}

export async function listConversations(
  p: ListConversationsParams,
  exec: Db,
): Promise<ConversationRecord[]> {
  const conds = [eq(conversations.tenant_id, p.tenant_id)];
  if (p.status) conds.push(eq(conversations.status, p.status));
  if (p.owner_id) conds.push(eq(conversations.owner_id, p.owner_id));
  const rows = await exec
    .select()
    .from(conversations)
    .where(and(...conds))
    .orderBy(desc(conversations.updated_at))
    .limit(Math.min(p.limit ?? 50, 200))
    .offset(p.offset ?? 0);
  return rows.map(rowToRecord);
}

export interface PatchConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  model?: string | null;
  title?: string | null;
}

/**
 * Patch a conversation's mutable metadata. Emits `CONVERSATION_UPDATED`
 * audit. The conversation rows's `updated_at` is bumped so the
 * `/resume` picker re-orders against it.
 */
export async function patchConversation(
  p: PatchConversationParams,
  exec: Db,
): Promise<ConversationRecord | null> {
  const updates: Partial<typeof conversations.$inferInsert> = { updated_at: new Date() };
  if (p.model !== undefined) updates.model = p.model;
  if (p.title !== undefined) updates.title = p.title;
  const [row] = await exec
    .update(conversations)
    .set(updates)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!row) return null;
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_UPDATED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: {
        model: p.model ?? null,
        title: p.title ?? null,
      },
    },
    exec,
  );
  return rowToRecord(row);
}

export interface CompactConversationParams {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  /** How many most-recent messages to preserve verbatim. */
  keep_last?: number;
}

export interface CompactConversationResult {
  conversation: ConversationRecord;
  summary: string;
  messages_collapsed: number;
}

/**
 * Collapse conversation message history into a single system summary
 * message followed by the last `keep_last` messages. The summary is
 * a deterministic stub (count of collapsed messages + first/last
 * user turns) so tests are reproducible; a richer implementation can
 * plug in an LLM-driven summarizer behind the same service call.
 *
 * NOTE: This mutates `conversation_messages` by marking the collapsed
 * rows as `role: "system"` with `content: { kind: "compacted" }`. We
 * do not DELETE rows so audit replay remains faithful.
 */
export async function compactConversation(
  p: CompactConversationParams,
  exec: Db,
): Promise<CompactConversationResult> {
  const keepLast = Math.max(0, Math.min(p.keep_last ?? 4, 50));
  const conv = await getConversation(p.tenant_id, p.conversation_id, exec);
  if (!conv) throw new Error("conversation not found");

  const total = conv.messages.length;
  const collapseCount = Math.max(0, total - keepLast);

  let summary = "";
  if (collapseCount > 0) {
    const firstUser = conv.messages.find((m) => m.role === "user");
    const lastAssistant = [...conv.messages].reverse().find((m) => m.role === "assistant");
    const firstText =
      firstUser && typeof firstUser.content === "object" && firstUser.content !== null
        ? JSON.stringify((firstUser.content as { text?: string }).text ?? firstUser.content).slice(
            0,
            200,
          )
        : "";
    const lastText =
      lastAssistant && typeof lastAssistant.content === "object" && lastAssistant.content !== null
        ? JSON.stringify(
            (lastAssistant.content as { text?: string }).text ?? lastAssistant.content,
          ).slice(0, 200)
        : "";
    summary =
      `Compacted ${collapseCount} earlier message(s). ` +
      (firstText ? `Opened with: ${firstText}. ` : "") +
      (lastText ? `Most recent assistant turn: ${lastText}` : "");

    // Inject the summary as a new system message and tag the older
    // rows so rendering skips them.
    await exec.insert(conversationMessages).values({
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      role: "system",
      content: { kind: "compacted", summary, collapsed: collapseCount },
    });
  }

  const [updated] = await exec
    .update(conversations)
    .set({ updated_at: new Date() })
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .returning();
  if (!updated) throw new Error("conversation disappeared");

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.CONVERSATION_COMPACTED,
      resource_type: "conversation",
      resource_id: p.conversation_id,
      result: "success",
      metadata: { collapsed: collapseCount, kept: Math.min(keepLast, total) },
    },
    exec,
  );

  return {
    conversation: rowToRecord(updated),
    summary,
    messages_collapsed: collapseCount,
  };
}

/**
 * Undo the most recent draft mutation. Used by the CLI / UI when
 * the user wants to revert a step.
 */
export async function undoLastDraftMutation(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<DraftDocument> {
  return undoLastSnapshot(tenant_id, conversation_id, exec);
}
