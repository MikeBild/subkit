import type { ConversationDetail } from "@/api/client";

export interface ChatChoice {
  id: string;
  toolCallId: string;
  question: string;
  options: { value: string; label: string; description?: string }[];
  expiresAt: string;
}

export function chatChoice(detail: ConversationDetail | undefined): ChatChoice | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (pending?.tool_name !== "ask_user_choice" || !pending.tool_call_id) return null;
  const call = detail?.tool_calls.find(
    (item) => item.id === pending.tool_call_id && item.tool === "ask_user_choice",
  );
  const input = call?.input as Partial<ChatChoice> | undefined;
  if (!input || typeof input.question !== "string" || !input.question.trim()) return null;
  if (!Array.isArray(input.options) || input.options.length < 2) return null;
  if (
    !input.options.every(
      (option) =>
        option &&
        typeof option.value === "string" &&
        option.value.trim() &&
        typeof option.label === "string" &&
        option.label.trim() &&
        (option.description === undefined || typeof option.description === "string"),
    )
  )
    return null;
  if (new Set(input.options.map((option) => option.value)).size !== input.options.length)
    return null;
  return {
    id: pending.id,
    toolCallId: pending.tool_call_id,
    question: input.question,
    options: input.options,
    expiresAt: pending.expires_at,
  };
}
