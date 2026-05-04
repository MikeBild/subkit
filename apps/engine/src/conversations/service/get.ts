// Read path: hydrate a full ConversationDetail (row + messages + tool
// calls + draft + resume_summary). Imported by nearly every other
// service operation, so it lives in its own file with no upstream
// service-layer imports.

import { and, asc, desc, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { loadDraft } from "../draft.ts";
import { buildResumeSummary, shouldShowResumeSummary } from "../resume.ts";
import type {
  ConversationDetail,
  ConversationMessageRecord,
  ConversationToolCallRecord,
} from "../types.ts";
import { type Executor, rowToRecord } from "./shared.ts";

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
  const conversationRecord = rowToRecord(row);
  const pendingElicitationRows = await exec
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, id),
        eq(conversationElicitations.status, "pending"),
      ),
    )
    .orderBy(desc(conversationElicitations.created_at))
    .limit(1);
  const pendingElicitation = pendingElicitationRows[0]
    ? {
        id: pendingElicitationRows[0].id,
        tool_name: pendingElicitationRows[0].tool_name,
        summary:
          typeof (pendingElicitationRows[0].input as { summary?: unknown })?.summary === "string"
            ? ((pendingElicitationRows[0].input as { summary?: string }).summary ?? null)
            : null,
      }
    : null;
  const resumeSummary = shouldShowResumeSummary({
    conversation: conversationRecord,
    draft,
    pendingElicitation,
  })
    ? buildResumeSummary({
        conversation: conversationRecord,
        draft,
        pendingElicitation,
      })
    : null;
  return {
    conversation: conversationRecord,
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
        parent_message_id: c.parent_message_id,
      }),
    ),
    draft,
    resume_summary: resumeSummary,
  };
}
