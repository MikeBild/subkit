// Shared chat adapter types.
//
// P12 ships the core of the chat layer — enough to drive a full
// mention → conversation → approval → commit through Slack, with
// Teams and Google Chat implemented at parity for signing and
// outbound API calls.

export type ChatPlatform = "slack" | "teams" | "google_chat";

/**
 * Platform-tagged raw envelope. A request that has successfully
 * passed `adapter.verify()` turns into a `VerifiedEvent`. The `raw`
 * field is the already-parsed JSON body (or form payload for Slack
 * interactions) — adapters do their own normalization in `receive()`.
 */
export interface VerifiedEvent {
  platform: ChatPlatform;
  raw: unknown;
}

export type ChatCommand =
  | { verb: "chat"; prompt: string }
  | { verb: "run"; workflow: string; args: Record<string, string> }
  | { verb: "help"; topic?: string };

export interface ChatInteractionAction {
  action_id: string;
  value?: string;
}

export interface ChatEvent {
  platform: ChatPlatform;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  user_id: string;
  kind: "mention" | "slash_command" | "interaction";
  text?: string;
  command?: ChatCommand;
  interaction?: ChatInteractionAction;
  raw: unknown;
}

export interface ChatDelivery {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  kind: "message" | "ephemeral" | "approval";
  text?: string;
  blocks?: unknown;
  card?: ApprovalCard;
}

export interface ApprovalCard {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  conversation_id: string;
  approval_id: string;
  summary: string;
  /** Markdown / rich description of what will happen on approve. */
  body?: string;
}

/**
 * Per-platform rate declarations. Notifications flow honors these via
 * `notifications/rate-limit.ts` token bucket. Direct adapter.send
 * traffic from `conversations/dispatcher.ts` is not yet wrapped —
 * deferred work applies the same limiter to all outbound adapter methods.
 */
export const CHAT_RATES: Record<ChatPlatform, { per_minute: number; burst: number }> = {
  slack: { per_minute: 60, burst: 20 },
  teams: { per_minute: 30, burst: 10 },
  google_chat: { per_minute: 60, burst: 20 },
};
