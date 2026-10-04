export type InboundChatPlatform = "slack" | "teams" | "google_chat";

export type ChatPlatform = InboundChatPlatform | "sk_cli";

export type OutboundSendResult = { platform_message_id: string } | { skipped: OutboundSkipReason };

export type OutboundSkipReason = "not_actionable";

export interface VerifiedEvent {
  platform: InboundChatPlatform;
  raw: unknown;
}

export type ChatCommand =
  | { verb: "chat"; prompt: string }
  | { verb: "run"; workflow: string; args: Record<string, string> }
  | { verb: "help"; topic?: string };

export interface ChatInteractionAction {
  action_id: string;
  value?: string;
  form_values?: Record<string, unknown>;
}

export type ElicitationKind = "confirm" | "choice" | "multi" | "text" | "form";

export interface ElicitationField {
  name: string;
  label?: string;
  type?: "text" | "textarea" | "number" | "email" | "date" | "select";
  options?: Array<{ value: string; label?: string }>;
  required?: boolean;
  placeholder?: string;
  default?: string;
}

export interface ChatElicitation {
  id: string;
  conversation_id: string;
  kind: ElicitationKind;
  summary: string;
  body?: string;
  options?: Array<{ value: string; label?: string }>;
  fields?: ElicitationField[];
}

export interface ChatAdapterCapabilities {
  interactive: ElicitationKind[];
}

export interface ChatEvent {
  platform: InboundChatPlatform;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  user_id: string;
  kind: "mention" | "slash_command" | "interaction" | "system";
  text?: string;
  command?: ChatCommand;
  interaction?: ChatInteractionAction;
  system_event?: string;
  is_direct_message?: boolean;
  space_display_name?: string;
  event_key?: string;
  traffic_class?: "organic" | "synthetic" | "internal";
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
  notification?: {
    severity: string;
    event_type: string;
    event_payload?: Record<string, unknown> | null;
  };
}

export interface ApprovalCard {
  tenant_id: string;
  workspace_id: string;
  channel_id: string;
  thread_id?: string;
  conversation_id: string;
  approval_id: string;
  summary: string;
  body?: string;
}

export const PLATFORM_HAS_GLOBAL_USER_IDS: Record<ChatPlatform, boolean> = {
  slack: false,
  teams: false,
  google_chat: true,
  sk_cli: false,
};

export const CHAT_RATES: Record<ChatPlatform, { per_minute: number; burst: number }> = {
  slack: { per_minute: 60, burst: 20 },
  teams: { per_minute: 30, burst: 10 },
  google_chat: { per_minute: 60, burst: 20 },
  sk_cli: { per_minute: 0, burst: 0 },
};
