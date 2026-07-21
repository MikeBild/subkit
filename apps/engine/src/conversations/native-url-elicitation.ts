import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { conversationElicitations } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

type CompletionNotifier = () => Promise<void>;

interface RegisteredCompletionNotifier {
  notify: CompletionNotifier;
  expires_at: number;
  expiry_timer: ReturnType<typeof setTimeout>;
}

const completionNotifiers = new Map<string, RegisteredCompletionNotifier>();

export function registerNativeUrlElicitationCompletion(
  elicitationId: string,
  notify: CompletionNotifier,
): () => void {
  const previous = completionNotifiers.get(elicitationId);
  if (previous) clearTimeout(previous.expiry_timer);

  const registered: RegisteredCompletionNotifier = {
    notify,
    expires_at: Date.now() + 10 * 60_000,
    expiry_timer: setTimeout(() => {
      if (completionNotifiers.get(elicitationId) === registered) {
        completionNotifiers.delete(elicitationId);
      }
    }, 10 * 60_000),
  };
  registered.expiry_timer.unref();
  completionNotifiers.set(elicitationId, registered);

  return () => {
    if (completionNotifiers.get(elicitationId) !== registered) return;
    clearTimeout(registered.expiry_timer);
    completionNotifiers.delete(elicitationId);
  };
}

export async function markConnectorNativeUrlElicitationsComplete(
  p: {
    tenant_id: string;
    connector_id: string;
    outcome: "succeeded" | "failed";
  },
  db: Db,
): Promise<number> {
  const rows = await db
    .update(conversationElicitations)
    .set({
      delivery_lease_id: null,
      delivery_lease_expires_at: null,
      delivery_last_error: p.outcome === "succeeded" ? "url_completed" : "url_failed",
      updated_at: new Date(),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.status, "pending"),
        sql`${conversationElicitations.input}->>'connector_id' = ${p.connector_id}`,
        sql`${conversationElicitations.input} ?| array['authorization_url', 'setup_url']`,
      ),
    )
    .returning({ id: conversationElicitations.id });

  for (const row of rows) {
    const registered = completionNotifiers.get(row.id);
    if (!registered) continue;
    clearTimeout(registered.expiry_timer);
    completionNotifiers.delete(row.id);
    if (registered.expires_at < Date.now()) continue;
    try {
      await registered.notify();
    } catch (err) {
      logger.warn({
        module: "conversation",
        action: "elicitation.url_completion_notification_failed",
        msg: "external URL elicitation completed but its MCP notification failed",
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        elicitation_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rows.length;
}
