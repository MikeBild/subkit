import type { ConversationDetail } from "@/api/client";

/**
 * A pending free-text question (`ask_user_text`) as the reader answers it.
 *
 * The question comes from the engine's `prompt.question` — never from
 * `summary`, which is empty for these rows — and falls back to the call's own
 * input. A question the assistant only asked in prose and the harness parked
 * has no tool call at all (`toolCallId: null`): it has no tool part in the
 * transcript to stand beside, so the page shows it on its own.
 */
export interface ChatText {
  id: string;
  toolCallId: string | null;
  question: string;
  placeholder?: string;
  initialValue?: string;
  multiline: boolean;
  /** Checked before submit; the engine checks it again on respond. */
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

/** False only when the answer is empty or the declared pattern rejects it. */
export function textAnswerAcceptable(text: Pick<ChatText, "pattern">, value: string): boolean {
  if (!value.trim()) return false;
  if (!text.pattern) return true;
  try {
    return new RegExp(text.pattern).test(value);
  } catch {
    // An invalid pattern is the engine's to judge; it re-validates on respond.
    return true;
  }
}

/** The question shortened for the one-line composer hint. */
export function questionExcerpt(question: string, max = 120): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Whether a transcript message carries the tool part this question belongs to. */
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
