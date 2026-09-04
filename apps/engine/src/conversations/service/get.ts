// Read path: hydrate a full ConversationDetail (row + messages + tool
// calls + draft + resume_summary). Imported by nearly every other
// service operation, so it lives in its own file with no upstream
// service-layer imports.

import { and, asc, desc, eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { stripFileSentinelsForDisplay } from "../../files/sentinel.ts";
import { loadDraft } from "../draft.ts";
import { buildResumeSummary, shouldShowResumeSummary } from "../resume.ts";
import type {
  ConversationCreatedResource,
  ConversationDetail,
  ConversationMessageRecord,
  ConversationToolCallRecord,
  DraftDocument,
} from "../types.ts";
import { loadOwners, rowToRecord } from "./shared.ts";

/**
 * Strip every `[file:fid_<uuid>]` sentinel out of a stored message
 * content blob. The persisted shape is `string` for legacy rows or
 * `{ text: string }` for the rewriter-canonical shape; both are walked.
 * Anything else (tool decision notes, structured payloads) passes
 * through untouched.
 */
function stripContentSentinels(content: unknown): unknown {
  if (typeof content === "string") return stripFileSentinelsForDisplay(content);
  if (content && typeof content === "object" && "text" in content) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return { ...obj, text: stripFileSentinelsForDisplay(obj.text) };
    }
  }
  return content;
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
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, id),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  const calls = await exec
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, id),
      ),
    )
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
        // Already on the selected row — no extra query for the deadline.
        expires_at: pendingElicitationRows[0].expires_at.toISOString(),
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
  const owners = await loadOwners(tenant_id, [conversationRecord.owner_id], exec);
  return {
    conversation: conversationRecord,
    owner: (conversationRecord.owner_id && owners.get(conversationRecord.owner_id)) || null,
    created_resources: collectCreatedResources(draft, calls),
    messages: msgs.map(
      (m): ConversationMessageRecord => ({
        id: m.id,
        conversation_id: m.conversation_id,
        role: m.role as ConversationMessageRecord["role"],
        // Strip `[file:fid_<uuid>]` sentinels from the content surfaced
        // to API consumers (CLI/REPL, web UI, MCP detail readers). The
        // canonical persisted form keeps the sentinel for replay
        // routing in `buildModelMessages`; the human/API surface gets
        // a `[file]` placeholder. Without this, the raw fid would land
        // in any UI that renders the conversation transcript.
        content: stripContentSentinels(m.content),
        model: m.model,
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
        confirmation_state: c.confirmation_state,
        approved_at: c.approved_at ? c.approved_at.toISOString() : null,
        outcome: (c.outcome as ConversationToolCallRecord["outcome"]) ?? null,
      }),
    ),
    draft,
    resume_summary: resumeSummary,
  };
}

/**
 * What a conversation brought into being: the workflows and connectors its
 * draft persisted, and the executions its tool calls started. Newest first,
 * so a header can list them next to the transcript.
 */
function collectCreatedResources(
  draft: DraftDocument | null,
  calls: Array<{ tool: string; output: unknown; created_at: Date }>,
): ConversationCreatedResource[] {
  const out: ConversationCreatedResource[] = [];
  for (const ref of draft?.summary?.persisted_resources ?? []) {
    out.push({ kind: ref.kind, id: ref.id, slug: ref.slug, name: ref.name, at: ref.saved_at });
  }
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.tool !== "run_workflow" && !call.tool.startsWith("wf_")) continue;
    const output = call.output as {
      execution_id?: unknown;
      data?: { execution_id?: unknown };
    } | null;
    const id =
      typeof output?.execution_id === "string"
        ? output.execution_id
        : typeof output?.data?.execution_id === "string"
          ? output.data.execution_id
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      kind: "execution",
      id,
      slug: call.tool.startsWith("wf_") ? call.tool.slice(3) : null,
      name: null,
      at: call.created_at.toISOString(),
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
