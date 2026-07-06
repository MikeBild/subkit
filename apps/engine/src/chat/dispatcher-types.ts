// Shared types for the dispatcher + its extracted helpers.
//
// Kept in its own file so `elicit-routing.ts` (which imports
// `DispatchOutcome`) doesn't pull in the dispatcher's full module
// graph, which would create a circular dependency back through
// `dispatcher.ts` → `elicit-routing.ts` → `dispatcher.ts`.

import type { RunLoopResult } from "../conversations/loop.ts";

export interface DispatchOutcome {
  status: "ok" | "workspace_not_found" | "ignored" | "help" | "approved" | "rejected";
  conversation_id?: string;
  approval_sent?: boolean;
  loop?: RunLoopResult;
  /** Set only when handleChatEvent ran with replyDelivery:"capture".
   *  The terminal assistant reply text the dispatcher WOULD have sent
   *  (already includes the "Committed."/"Still thinking…" fallbacks).
   *  null when there is no terminal reply to post (awaiting_input →
   *  approval_sent true; ignored/help → ephemeral already sent inline). */
  reply_text?: string | null;
}

/** Options for `handleChatEvent`. `replyDelivery:"capture"` computes the
 *  terminal assistant reply but does NOT send it — the synchronous
 *  Google-Chat path owns delivery (HTTP body or a detached send) so the
 *  reply has exactly one sender. Default `"send"` is byte-identical to
 *  the pre-F2 behavior. */
export interface HandleChatEventOpts {
  replyDelivery?: "send" | "capture";
}
