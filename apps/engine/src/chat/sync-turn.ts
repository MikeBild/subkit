import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { chatWorkspaces } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ChatAdapter } from "./adapter.ts";
import { markChatEventSeen } from "./dedup.ts";
import { deliverChatReply, handleChatEvent } from "./dispatcher.ts";
import { formatChatText } from "./format/outbound-format.ts";
import type { ChatEvent, ChatPlatform } from "./types.ts";

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

  if (event.event_key) {
    const fresh = await markChatEventSeen(db, {
      tenant_id: workspace.tenant_id,
      workspace_id: workspace.id,
      platform_event_id: event.event_key,
    });
    if (!fresh) return { deliver: "acked" };
  }

  const turnP = handleChatEvent({ db, adapter }, event, { replyDelivery: "capture" });
  const winner = await Promise.race([
    turnP.then((o) => ({ kind: "done" as const, o })),
    sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (winner.kind === "done") {
    const o = winner.o;
    if (o.approval_sent === true) return { deliver: "acked" };
    if (o.reply_text != null) {
      return {
        deliver: "sync",
        text: formatChatText(event.platform as ChatPlatform, o.reply_text),
      };
    }
    return { deliver: "acked" };
  }

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
