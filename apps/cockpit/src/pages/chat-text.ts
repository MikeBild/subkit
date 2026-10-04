import type { ConversationDetail } from "@/api/client";

export interface ChatText {
  id: string;
  toolCallId: string | null;
  question: string;
  placeholder?: string;
  initialValue?: string;
  multiline: boolean;
  pattern?: string;
  expiresAt: string;
}

export function chatText(detail: ConversationDetail | undefined): ChatText | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (pending?.tool_name !== "ask_user_text") return null;
  const toolCallId = pending.tool_call_id ?? null;
  const call = toolCallId
    ? detail?.tool_calls.find((item) => item.id === toolCallId && item.tool === "ask_user_text")
    : undefined;
  const input = isRecord(call?.input) ? call.input : {};
  const question = [pending.prompt?.question, input.question].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!question) return null;
  return {
    id: pending.id,
    toolCallId,
    question,
    ...(nonEmpty(input.placeholder) ? { placeholder: input.placeholder } : {}),
    ...(nonEmpty(input.default) ? { initialValue: input.default } : {}),
    multiline: input.multiline === true,
    ...(nonEmpty(input.validation_regex) ? { pattern: input.validation_regex } : {}),
    expiresAt: pending.expires_at,
  };
}

export function textAnswerAcceptable(text: Pick<ChatText, "pattern">, value: string): boolean {
  if (!value.trim()) return false;
  if (!text.pattern) return true;
  try {
    return new RegExp(text.pattern).test(value);
  } catch {
    return true;
  }
}

export function questionExcerpt(question: string, max = 120): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function questionIsInTranscript(
  text: Pick<ChatText, "toolCallId">,
  messages: readonly { parts: readonly unknown[] }[],
): boolean {
  if (!text.toolCallId) return false;
  return messages.some((message) =>
    message.parts.some(
      (part) => isRecord(part) && part.type === "tool_call" && part.call_id === text.toolCallId,
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
