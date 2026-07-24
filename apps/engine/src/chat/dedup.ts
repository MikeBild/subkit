// Replay dedup for inbound chat events.
//
// Backed by the `chat_events_seen` table with a unique index on
// `(workspace_id, platform_event_id)`. We attempt an INSERT and treat a
// unique-violation as "already seen". Mirrors `webhooks/inbound/dedup.ts`.
//
// The dedup row must be inserted at the *start* of the chat.event worker
// run, before any dispatch — otherwise a Slack retry that arrives while
// the first turn is still running can squeeze past the check and double-
// dispatch (Slack retries up to 3× on x-slack-retry-num).

import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { recordUsageEvent } from "../stats/usage-events.ts";

export interface MarkChatEventSeenInput {
  tenant_id: string;
  /** `chat_workspaces.id` (UUID), NOT the platform-native team/workspace id. */
  workspace_id: string;
  /** The platform-native event id: Slack `event_id` (Events API), `view.id`
   *  (`view_submission`), `trigger_id` (`block_actions`), or a hash of
   *  `command+text+ts` for slash commands. */
  platform_event_id: string;
}

/**
 * Returns true if the row was newly inserted (proceed with dispatch),
 * false if it already existed (drop — this is a replay).
 */
export async function markChatEventSeen(
  db: Executor,
  input: MarkChatEventSeenInput,
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO "chat_events_seen" ("tenant_id", "workspace_id", "platform_event_id")
    VALUES (${input.tenant_id}, ${input.workspace_id}, ${input.platform_event_id})
    ON CONFLICT ("workspace_id", "platform_event_id") DO NOTHING
    RETURNING "platform_event_id"
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  const fresh = rows.length > 0;
  if (!fresh) {
    recordUsageEvent(db, {
      tenantId: input.tenant_id,
      surface: "chat",
      operation: "event/deduplicated",
      method: "EVENT",
      outcome: "deduplicated",
      requestSource: "chat",
      sessionId: `${input.workspace_id}:${input.platform_event_id}`,
      responseMode: "none",
    });
  }
  return fresh;
}
