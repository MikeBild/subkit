// Replay-id dedup for inbound webhooks.
//
// Backed by the `webhook_replay_seen` table with a unique index on
// `(tenant_id, webhook_id, standard_webhook_id)`. We attempt an
// INSERT and interpret a unique-violation as "already seen".

import { sql } from "drizzle-orm";

import type { Executor } from "../../db/client.ts";

export interface MarkSeenInput {
  tenant_id: string;
  webhook_id: string; // webhooks_inbound.id
  standard_webhook_id: string; // the provider-native event id
}

/** Read existing receipts without consuming a delivery that may still fail admission or enqueue. */
export async function wasSeen(db: Executor, input: MarkSeenInput): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM "webhook_replay_seen"
    WHERE "tenant_id" = ${input.tenant_id} AND "webhook_id" = ${input.webhook_id}
      AND "standard_webhook_id" = ${input.standard_webhook_id}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Returns true if the row was newly inserted, false if it already
 * existed (i.e. this is a replay).
 */
export async function markSeenIfNew(db: Executor, input: MarkSeenInput): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO "webhook_replay_seen" ("tenant_id", "webhook_id", "standard_webhook_id")
    VALUES (${input.tenant_id}, ${input.webhook_id}, ${input.standard_webhook_id})
    ON CONFLICT ("tenant_id", "webhook_id", "standard_webhook_id") DO NOTHING
    RETURNING "standard_webhook_id"
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? [];
  return rows.length > 0;
}
