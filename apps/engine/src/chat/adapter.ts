// ChatAdapter interface. One per platform, one instance per tenant
// workspace (see registry.ts). Adapters are responsible for:
//
//   - verify(): inbound signature verification (signing-secret HMAC
//     for Slack, JWT+JWKS for Teams, JWT for Google Chat).
//   - receive(): normalize a VerifiedEvent into a ChatEvent.
//   - send / update / sendApproval: outbound API calls.
//
// Rate-limiting: every outbound path shares the per-(tenant, workspace,
// channel) token bucket from `notifications/rate-limit.ts`, honoring the
// per-platform ceilings in `CHAT_RATES` (`./types.ts`). Conversation
// replies go through the dispatcher's `sendTracked` (exhaustion drops
// the send with a `rate_limited` metric); load-bearing interactive
// messages (`renderElicitation` / `sendApproval`) consume from the same
// bucket via `consumeInteractiveSlot` but are never dropped — an unsent
// card would strand the conversation in awaiting_input.

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
  /** Native elicitation rendering. When present, the dispatcher hands a
   *  provider-neutral elicitation to the adapter and the adapter
   *  produces the right native UI (Slack: inline interactive blocks for
   *  confirm/choice/multi, an "Antworten" button for text/form that
   *  opens a modal; Teams Adaptive Cards; Google Chat dialogs). Absence
   *  falls back to the legacy `sendApproval` Approve/Reject card so
   *  adapters that haven't shipped native rendering yet still work. */
  capabilities?: ChatAdapterCapabilities;
  renderElicitation?(
    elicitation: ChatElicitation,
    target: { tenant_id: string; workspace_id: string; channel_id: string; thread_id?: string },
  ): Promise<{ platform_message_id: string }>;
  /** Synchronous platform-specific fast path for interactions that must
   *  beat a short deadline. Slack uses this to call `views.open` within
   *  the ~3 s `trigger_id` window when the user clicks an "Antworten"
   *  button on a text/form elicitation message; the chat HTTP route
   *  invokes this BEFORE enqueueing so the queue's latency doesn't eat
   *  the window. Adapters that don't need a fast path (Teams Adaptive
   *  Cards are inline; Google dialogs open from card actions in-band)
   *  omit this. Returns true when the interaction was handled inline
   *  and the chat.event queue enqueue should be skipped. */
  handleSyncInteraction?(args: {
    event: ChatEvent;
    db: import("../db/client.ts").Db;
  }): Promise<{ handled: boolean }>;
}
