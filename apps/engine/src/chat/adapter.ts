import type {
  ApprovalCard,
  ChatAdapterCapabilities,
  ChatDelivery,
  ChatElicitation,
  ChatEvent,
  ChatPlatform,
  VerifiedEvent,
} from "./types.ts";

export interface ChatAdapter {
  readonly platform: ChatPlatform;
  verify(req: Request): Promise<VerifiedEvent | null>;
  receive(ev: VerifiedEvent): Promise<ChatEvent>;
  send(delivery: ChatDelivery): Promise<{ platform_message_id: string }>;
  update(delivery: ChatDelivery, platform_message_id: string): Promise<void>;
  sendApproval(card: ApprovalCard): Promise<{ platform_message_id: string }>;
  capabilities?: ChatAdapterCapabilities;
  renderElicitation?(
    elicitation: ChatElicitation,
    target: { tenant_id: string; workspace_id: string; channel_id: string; thread_id?: string },
  ): Promise<{ platform_message_id: string }>;
  handleSyncInteraction?(args: {
    event: ChatEvent;
    db: import("../db/client.ts").Db;
  }): Promise<{ handled: boolean; response?: unknown; enqueue?: boolean }>;
}
