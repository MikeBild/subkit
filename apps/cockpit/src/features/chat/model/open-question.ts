import type { OpenQuestion } from "@shared/typed-reply.ts";
import type { ConversationDetail } from "@/api/client";

type Detail = Pick<ConversationDetail, "resume_summary" | "tool_calls">;

export function openQuestionOf(
  detail: Detail,
  now: number = Date.now(),
): (OpenQuestion & { id: string }) | null {
  const pending = detail.resume_summary?.pending_approval;
  if (!pending) return null;
  if (Date.parse(pending.expires_at) <= now) return null;
  const call = pending.tool_call_id
    ? detail.tool_calls.find((item) => item.id === pending.tool_call_id)
    : undefined;
  return { id: pending.id, tool_name: pending.tool_name, input: call?.input };
}
