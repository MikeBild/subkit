import { sql } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";

export interface MarkSeenInput {
  tenant_id: string;
  webhook_id: string;
  standard_webhook_id: string;
}

export async function wasSeen(db: Executor, input: MarkSeenInput): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM "webhook_replay_seen"
    WHERE "tenant_id" = ${input.tenant_id} AND "webhook_id" = ${input.webhook_id}
      AND "standard_webhook_id" = ${input.standard_webhook_id}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

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
