import {
  type ConversationReference,
  isConversationReferenceType,
} from "@shared/conversation-reference.ts";
import { messageOrigin } from "./task-run-continuation.ts";
import type {
  ContentPart,
  ConversationMessageRecord,
  ConversationToolCallRecord,
  UIMessage,
} from "./types.ts";

export function toMessageParts(
  message: ConversationMessageRecord,
  toolCalls: ConversationToolCallRecord[],
): UIMessage {
  const parts: ContentPart[] = [];
  const text = extractText(message.content);
  if (text !== null && text.length > 0) {
    const refs = extractReferences(message.content);
    const decision = extractDecision(message.content);
    parts.push({
      type: "text",
      text,
      ...(refs.references ? { references: refs.references } : {}),
      ...(refs.unresolved ? { unresolved_references: refs.unresolved } : {}),
      ...(decision ? { decision } : {}),
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

  const origin = messageOrigin(message.content);
  return {
    id: message.id,
    role: message.role,
    parts,
    model: message.model,
    created_at: message.created_at,
    ...(origin ? { origin } : {}),
  };
}

export function buildMessages(
  messages: ConversationMessageRecord[],
  toolCalls: ConversationToolCallRecord[],
): UIMessage[] {
  const assistantToolCalls = groupToolCallsByAssistantTurn(messages, toolCalls);
  return messages.map((m) => toMessageParts(m, assistantToolCalls.get(m.id) ?? []));
}

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
  for (const list of out.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return out;
}

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
        isConversationReferenceType((r as { type?: unknown }).type) &&
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

function extractDecision(content: unknown): { state: string; tool: string | null } | null {
  if (content === null || typeof content !== "object") return null;
  const rec = content as Record<string, unknown>;
  if (rec.kind !== "confirmation_decision" || typeof rec.to_state !== "string") return null;
  return { state: rec.to_state, tool: typeof rec.tool === "string" ? rec.tool : null };
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
