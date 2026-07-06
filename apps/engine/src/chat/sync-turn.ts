// Synchronous Google-Chat response path.
//
// Google Chat renders "[app] is not responding" whenever the SYNCHRONOUS
// HTTP response to its events webhook is not a valid Chat `Message` — an
// empty `{ok:true}` ack does NOT suffice, even when the real reply is
// delivered async via `spaces.messages.create`. For a MESSAGE that runs a
// conversation turn we therefore run the turn INLINE, bounded by a
// timeout below Google's ~30s window, and return the rendered reply as the
// HTTP body when it finishes fast.
//
// NO-DOUBLE-SEND is the load-bearing invariant. This helper is the single
// delivery owner for the terminal assistant reply:
//
//   1. It claims `markChatEventSeen` (the SAME dedup row the queue worker
//      claims) BEFORE dispatch, so a racing Google retry OR the worker
//      finds the row taken and drops — the turn runs exactly once.
//   2. It runs `handleChatEvent(..., {replyDelivery:"capture"})`, a mode
//      where the dispatcher computes the terminal reply but never sends
//      it. Delivery happens in exactly one place:
//        - fast finish → the route returns { text } as the HTTP body;
//        - timeout     → the still-running turn is DETACHED and self-
//          delivers its captured reply via `deliverChatReply` on
//          completion (not aborted — we bound the WAIT, not the turn).
//      The queue is never enqueued on any owning branch.
//   3. `awaiting_input` cards and ignored/help ephemerals are already
//      sent inline by the dispatcher (capture mode narrowly suppresses
//      ONLY the terminal assistant reply), so the helper just acks.
//
// When no workspace is registered yet (first DM) or the event was already
// seen, the helper DEFERS: it claims nothing and returns so the route
// falls through to the existing `enqueue` + `{ok:true}`, leaving the queue
// worker to own DM auto-registration, dedup, the turn, and the async send
// end-to-end (unchanged, pg-boss-retried path).

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ChatAdapter } from "./adapter.ts";
import { markChatEventSeen } from "./dedup.ts";
import { deliverChatReply, handleChatEvent } from "./dispatcher.ts";
import { formatChatText } from "./format/outbound-format.ts";
import type { ChatEvent, ChatPlatform } from "./types.ts";

/**
 * Result of an inline synchronous turn attempt.
 *   - `sync`  → the route returns `{ text }` as the HTTP body (Google
 *               posts it). Nothing enqueued, nothing sent by the
 *               dispatcher — single delivery via the body.
 *   - `acked` → the route returns `{ ok:true }`; do NOT enqueue. Used when
 *               a card/ephemeral was already sent inline, the turn was
 *               detached on timeout, or the event was already claimed.
 *   - `defer` → the route falls through to the existing enqueue +
 *               `{ ok:true }`. The queue worker owns the whole event.
 */
export type ChatSyncResult =
  | { deliver: "sync"; text: string }
  | { deliver: "acked" }
  | { deliver: "defer" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runChatTurnSync(args: {
  db: Db;
  adapter: ChatAdapter;
  event: ChatEvent;
  timeoutMs: number;
}): Promise<ChatSyncResult> {
  const { db, adapter, event, timeoutMs } = args;

  // 1. Resolve the workspace. If none, the space isn't registered yet
  //    (first DM). DM auto-registration is the queue worker's job — defer
  //    and claim no dedup so the worker owns the event end-to-end.
  //    tenant-filter:exempt — platform/workspace_id lookup pre-tenant.
  const [workspace] = await db
    .select()
    .from(chatWorkspaces)
    .where(
      and(
        eq(chatWorkspaces.platform, event.platform),
        eq(chatWorkspaces.workspace_id, event.workspace_id),
      ),
    )
    .limit(1);
  if (!workspace) return { deliver: "defer" };

  // 2. Claim dedup FIRST — the same `(workspace.id, event_key)` row the
  //    queue worker claims. If a Google retry or the worker already took
  //    it, drop (ack) so the turn never double-runs. A missing event_key
  //    is treated as fresh (same no-op the worker does), accepting the
  //    small double-run risk documented in the F2 design (R6).
  if (event.event_key) {
    const fresh = await markChatEventSeen(db, {
      tenant_id: workspace.tenant_id,
      workspace_id: workspace.id,
      platform_event_id: event.event_key,
    });
    if (!fresh) return { deliver: "acked" };
  }

  // 3. Race the capture-mode turn against the bounded timeout. Capture
  //    mode means the dispatcher never sends the terminal reply — this
  //    helper is its sole delivery owner.
  const turnP = handleChatEvent({ db, adapter }, event, { replyDelivery: "capture" });
  const winner = await Promise.race([
    turnP.then((o) => ({ kind: "done" as const, o })),
    sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (winner.kind === "done") {
    const o = winner.o;
    // A card/ephemeral was already posted inline by the dispatcher.
    if (o.approval_sent === true) return { deliver: "acked" };
    // A terminal assistant reply to post as the HTTP body. Format it
    // through the SAME dialect converter `sendTracked` uses, or bold /
    // bullets render literally.
    if (o.reply_text != null) {
      return {
        deliver: "sync",
        text: formatChatText(event.platform as ChatPlatform, o.reply_text),
      };
    }
    // ignored / help — an ephemeral was already sent inline (or the event
    // was a no-op); nothing terminal to post.
    return { deliver: "acked" };
  }

  // 4. Timeout fired first. Do NOT abort the turn — bound the WAIT, not
  //    the turn. Detach it: it self-delivers its captured reply on
  //    completion. Bun keeps the promise alive after the response returns.
  //    Dedup (already claimed) makes this exactly-once.
  turnP
    .then((o) => {
      if (!o.approval_sent && o.reply_text != null) {
        return deliverChatReply(adapter, event.platform, {
          tenant_id: workspace.tenant_id,
          workspace_id: event.workspace_id,
          channel_id: event.channel_id,
          ...(event.thread_id ? { thread_id: event.thread_id } : {}),
          kind: "message",
          text: o.reply_text,
        });
      }
      return undefined;
    })
    .catch((err) => {
      logger.error({
        module: "chat",
        action: "sync_turn.detached_deliver_failed",
        msg: "detached Google-Chat turn failed after sync timeout — reply not delivered",
        platform: event.platform,
        workspace_id: event.workspace_id,
        channel_id: event.channel_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return { deliver: "acked" };
}
