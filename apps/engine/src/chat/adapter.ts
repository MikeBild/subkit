// ChatAdapter interface. One per platform, one instance per tenant
// workspace (see registry.ts). Adapters are responsible for:
//
//   - verify(): inbound signature verification (signing-secret HMAC
//     for Slack, JWT+JWKS for Teams, JWT for Google Chat).
//   - receive(): normalize a VerifiedEvent into a ChatEvent.
//   - send / update / sendApproval: outbound API calls.
//
// Progressive-edit coalescing is intentionally out of scope for P12;
// the dispatcher calls `send` and later `update` directly without
// debouncing. TODO(P13): wire a per-delivery coalescer in front of
// update() and bucket rate-limit enforcement around all three
// outbound methods (see CHAT_RATES).

import type {
  ApprovalCard,
  ChatDelivery,
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
}
