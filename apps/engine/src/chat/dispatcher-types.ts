import type { RunLoopResult } from "../conversations/loop/index.ts";

export interface DispatchOutcome {
  status: "ok" | "workspace_not_found" | "ignored" | "help" | "approved" | "rejected";
  conversation_id?: string;
  approval_sent?: boolean;
  loop?: RunLoopResult;
  reply_text?: string | null;
}

export interface HandleChatEventOpts {
  replyDelivery?: "send" | "capture";
}
