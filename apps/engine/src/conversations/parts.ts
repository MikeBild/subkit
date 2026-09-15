// Content-parts adapter — reconstructs a parts-based `UIMessage` shape
// from the flat `ConversationMessageRecord.content` JSONB plus the
// conversation's tool calls. Mirrors Vercel AI SDK UI's `UIMessage`.
//
// The engine still persists `content: unknown`; this adapter is the
// read-side projection consumed by `messages_v2` on the detail
// endpoint. Once CLIs consume `messages_v2` exclusively a later PR can
// physically migrate rows.

import type { ConversationReference } from "./references.ts";
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
    // A user turn carries its @-mentions next to the text so the client
    // can render chips after a reload; the engine wrote them at ingest.
    const refs = extractReferences(message.content);
    parts.push({
      type: "text",
      text,
      ...(refs.references ? { references: refs.references } : {}),
      ...(refs.unresolved ? { unresolved_references: refs.unresolved } : {}),
    });
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
        outcome: tc.outcome,
        ...(tc.tool === "ask_user_confirm" && tc.confirmation_state
          ? { confirmation_state: tc.confirmation_state }
          : {}),
      });
    }
  }

  return {
    id: message.id,
    role: message.role,
    parts,
    model: message.model,
    created_at: message.created_at,
  };
}

/**
 * Project every persisted message in a conversation. Tool calls are
 * attached to assistant messages via explicit `parent_message_id`.
 * Unanchored legacy rows are ignored here and remain available only on
 * the raw `tool_calls` detail surface.
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
 * message. Only explicit anchors are considered. Unanchored rows stay
 * visible through the raw detail endpoint rather than being guessed
 * into `messages_v2`.
 */
function groupToolCallsByAssistantTurn(
  messages: ConversationMessageRecord[],
  toolCalls: ConversationToolCallRecord[],
): Map<string, ConversationToolCallRecord[]> {
  const out = new Map<string, ConversationToolCallRecord[]>();
  const messageIds = new Set(messages.map((m) => m.id));
  for (const tc of toolCalls) {
    if (!tc.parent_message_id || !messageIds.has(tc.parent_message_id)) continue;
    const list = out.get(tc.parent_message_id as string) ?? [];
    list.push(tc);
    out.set(tc.parent_message_id as string, list);
  }
  // Stable order within each bucket so the renderer sees children in
  // the same chronological order they were created.
  for (const list of out.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return out;
}

/**
 * True when a persisted message content carries non-empty prose. The stream
 * replay uses this to mirror the live loop's `lastAssistantText` gate: a
 * terminal citations frame is emitted only for a turn that produced an actual
 * answer, not one that ended tool-only or was cancelled mid-flight.
 */
export function messageHasText(content: unknown): boolean {
  const text = extractText(content);
  return text !== null && text.length > 0;
}

function isReferenceArray(value: unknown): value is ConversationReference[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { id?: unknown }).id === "string" &&
        typeof (r as { type?: unknown }).type === "string" &&
        typeof (r as { label?: unknown }).label === "string",
    )
  );
}

function extractReferences(content: unknown): {
  references: ConversationReference[] | null;
  unresolved: ConversationReference[] | null;
} {
  if (!content || typeof content !== "object") return { references: null, unresolved: null };
  const rec = content as Record<string, unknown>;
  return {
    references: isReferenceArray(rec.references) ? rec.references : null,
    unresolved: isReferenceArray(rec.unresolved_references) ? rec.unresolved_references : null,
  };
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
