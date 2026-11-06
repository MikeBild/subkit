import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";

export async function readDatabaseNow(db: Executor): Promise<Date> {
  const clock = await db.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`);
  const now = clock.rows[0]?.now;
  if (!now) throw new Error("database clock unavailable");
  return new Date(now);
}
