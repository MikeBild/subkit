import type { ConversationDetail } from "@/api/client";

export interface ChatApproval {
  id: string;
  toolCallId: string;
  question: string;
  description: string | null;
  savesInactiveWorkflow: boolean;
  expiresAt: string;
  oauth?: "start" | "complete";
  singleRun?: boolean;
  workflowName?: string;
  authorizationUrl?: string;
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
  const call = detail?.tool_calls.find((candidate) => candidate.id === pending.tool_call_id);
  if (!call) return null;
  if (call.tool !== "ask_user_confirm" && !pending.prompt) return null;
  const input = pending.prompt
    ? { ...pending.prompt, commit_intent: { kind: pending.prompt.intent_kind } }
    : record(call.input);
  const intent = record(input.commit_intent);
  if (typeof input.question !== "string" || !input.question.trim()) return null;
  return {
    id: pending.id,
    toolCallId: call.id,
    question: input.question,
    description: typeof intent.description === "string" ? intent.description : null,
    savesInactiveWorkflow: intent.kind === "save_workflow_draft",
    expiresAt: pending.expires_at,
    ...(intent.kind === "commit_held_workflow_writes"
      ? { singleRun: true, workflowName: detail?.resume_summary?.active_target?.name ?? undefined }
      : {}),
    ...(call.tool === "authenticate_oauth"
      ? {
          oauth: (pending.prompt?.intent_kind === "oauth_completed" ? "complete" : "start") as
            | "complete"
            | "start",
        }
      : {}),
    ...(pending.prompt?.authorization_url
      ? { authorizationUrl: pending.prompt.authorization_url }
      : {}),
  };
}
