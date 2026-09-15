import type { ConversationDetail } from "@/api/client";

export interface ChatApproval {
  id: string;
  toolCallId: string;
  question: string;
  description: string | null;
  savesInactiveWorkflow: boolean;
  expiresAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Bind the human decision to the exact pending elicitation and its originating call. */
export function chatApproval(detail: ConversationDetail | undefined): ChatApproval | null {
  const pending = detail?.resume_summary?.pending_approval;
  if (pending?.tool_name !== "ask_user_confirm" || !pending.tool_call_id) return null;
  const call = detail?.tool_calls.find(
    (candidate) => candidate.id === pending.tool_call_id && candidate.tool === "ask_user_confirm",
  );
  if (!call) return null;
  const input = record(call.input);
  const intent = record(input.commit_intent);
  if (typeof input.question !== "string" || !input.question.trim()) return null;
  return {
    id: pending.id,
    toolCallId: call.id,
    question: input.question,
    description: typeof intent.description === "string" ? intent.description : null,
    savesInactiveWorkflow: intent.kind === "save_workflow_draft",
    expiresAt: pending.expires_at,
  };
}
