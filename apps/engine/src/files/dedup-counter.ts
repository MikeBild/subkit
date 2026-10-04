import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { filesDedupSeen } from "../db/schema/files.ts";

export async function recordFilesDedupSeen(db: Db, tenant_id: string): Promise<void> {
  await db
    .insert(filesDedupSeen)
    .values({ tenant_id, count: 1, updated_at: new Date() })
    .onConflictDoUpdate({
      target: filesDedupSeen.tenant_id,
      set: {
        count: sql`${filesDedupSeen.count} + 1`,
        updated_at: new Date(),
      },
    });
}
