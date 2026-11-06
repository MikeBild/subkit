import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";

export async function oldestAuditTimestamp(db: Db, tenantId: string): Promise<Date | null> {
  const row = (
    await db.execute(sql`select min(ts) as oldest from audit_log where tenant_id = ${tenantId}`)
  ).rows[0] as { oldest: string | null } | undefined;
  return row?.oldest ? new Date(row.oldest) : null;
}
