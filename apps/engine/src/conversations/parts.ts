// Content-parts adapter — reconstructs a parts-based `UIMessage` shape
// from the flat `ConversationMessageRecord.content` JSONB plus the
// conversation's tool calls. Mirrors Vercel AI SDK UI's `UIMessage`.
//
// The engine still persists `content: unknown`; this adapter is the
// read-side projection consumed by `messages_v2` on the detail
// endpoint. Once CLIs consume `messages_v2` exclusively a later PR can
// physically migrate rows.

import type {
  ContentPart,
  ConversationMessageRecord,
  ConversationToolCallRecord,
  UIMessage,
} from "./types.ts";

/**
 * Project a single persisted message into its parts array. Tool calls
 * associated with the message via position are inlined as
 * `tool_call` + `tool_result` parts so the client can render the
 * call + result inline without a separate list.
 */
export function toMessageParts(
  message: ConversationMessageRecord,
  toolCalls: ConversationToolCallRecord[],
): UIMessage {
  const parts: ContentPart[] = [];
  const text = extractText(message.content);
  if (text !== null && text.length > 0) {
    parts.push({ type: "text", text });
  }

  if (message.role === "assistant") {
    for (const tc of toolCalls) {
      parts.push({
        type: "tool_call",
        call_id: tc.id,
        tool: tc.tool,
        input: tc.input,
        phase: "result",
      });
      parts.push({
        type: "tool_result",
        call_id: tc.id,
        tool: tc.tool,
        output: tc.output,
      });
    }
  }

  return {
    id: message.id,
    role: message.role,
    parts,
    created_at: message.created_at,
  };
}

/**
 * Project every persisted message in a conversation. Tool calls are
 * attached to assistant messages in insertion order — the engine writes
 * them contiguously today, so a positional join matches reality without
 * needing a foreign-key column.
 */
export function buildMessagesV2(
  messages: ConversationMessageRecord[],
  toolCalls: ConversationToolCallRecord[],
): UIMessage[] {
  const assistantToolCalls = groupToolCallsByAssistantTurn(messages, toolCalls);
  return messages.map((m) => toMessageParts(m, assistantToolCalls.get(m.id) ?? []));
}

/**
 * Walk the messages and group tool calls under their parent assistant
 * message. Prefers the explicit `parent_message_id` column (populated
 * by the loop for every new write since migration 0032) and falls
 * back to a time-window join for legacy rows where the column is null.
 *
 * Time-window fallback: for every assistant message, collect rows whose
 * `created_at` falls between that message and the next user/system
 * message. Robust as long as inserts happen in causal order, which the
 * loop guarantees. Always-O(n+m) on sorted input.
 */
function groupToolCallsByAssistantTurn(
  messages: ConversationMessageRecord[],
  toolCalls: ConversationToolCallRecord[],
): Map<string, ConversationToolCallRecord[]> {
  const out = new Map<string, ConversationToolCallRecord[]>();
  const messageIds = new Set(messages.map((m) => m.id));
  const anchored: ConversationToolCallRecord[] = [];
  const orphaned: ConversationToolCallRecord[] = [];
  for (const tc of toolCalls) {
    if (tc.parent_message_id && messageIds.has(tc.parent_message_id)) {
      anchored.push(tc);
    } else {
      orphaned.push(tc);
    }
  }
  for (const tc of anchored) {
    const list = out.get(tc.parent_message_id as string) ?? [];
    list.push(tc);
    out.set(tc.parent_message_id as string, list);
  }
  // Stable order within each bucket so the renderer sees children in
  // the same chronological order they were created.
  for (const list of out.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  if (orphaned.length === 0) return out;

  const sortedCalls = orphaned.sort((a, b) => a.created_at.localeCompare(b.created_at));
  let callCursor = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined || m.role !== "assistant") continue;
    const next = messages[i + 1];
    const windowEnd = next ? next.created_at : null;
    const bucket: ConversationToolCallRecord[] = out.get(m.id) ?? [];
    while (callCursor < sortedCalls.length) {
      const tc = sortedCalls[callCursor];
      if (tc === undefined) break;
      if (tc.created_at < m.created_at) {
        callCursor += 1;
        continue;
      }
      if (windowEnd !== null && tc.created_at >= windowEnd) break;
      bucket.push(tc);
      callCursor += 1;
    }
    if (bucket.length > 0) {
      bucket.sort((a, b) => a.created_at.localeCompare(b.created_at));
      out.set(m.id, bucket);
    }
  }
  return out;
}

function extractText(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (Array.isArray(rec.parts)) {
      const joined = rec.parts
        .map((p) =>
          typeof p === "object" && p !== null && typeof (p as { text?: unknown }).text === "string"
            ? (p as { text: string }).text
            : "",
        )
        .join("");
      return joined.length > 0 ? joined : null;
    }
  }
  return null;
}
