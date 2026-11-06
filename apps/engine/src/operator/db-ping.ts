import { sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/index.ts";

export async function pingDatabase(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (err) {
    logger.warn({
      module: "http",
      action: "health.db_ping_failed",
      msg: "db ping failed in /ready",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
