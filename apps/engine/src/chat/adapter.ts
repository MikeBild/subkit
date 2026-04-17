// ChatAdapter interface. One per platform, one instance per tenant
// workspace (see registry.ts). Adapters are responsible for:
//
//   - verify(): inbound signature verification (signing-secret HMAC
//     for Slack, JWT+JWKS for Teams, JWT for Google Chat).
//   - receive(): normalize a VerifiedEvent into a ChatEvent.
//   - send / update / sendApproval: outbound API calls.
//
// Rate-limiting is enforced for NOTIFICATIONS via `notifications/rate-limit.ts`
// (token bucket per channel). Direct `conversations/dispatcher.ts` traffic
// (user-driven chat turns) currently bypasses the bucket — deferred P13
// work will wrap `send`/`update`/`sendApproval` with the same limiter
// plus a per-delivery coalescer for progressive edits. `CHAT_RATES` in
// `./types.ts` declares the per-platform ceilings the limiter should honor.

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
