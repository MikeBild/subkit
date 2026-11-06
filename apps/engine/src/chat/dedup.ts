import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { recordUsageEvent } from "../stats/usage-events.ts";

interface MarkChatEventSeenInput {
  tenant_id: string;
  workspace_id: string;
  platform_event_id: string;
}

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
