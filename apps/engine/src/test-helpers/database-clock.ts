import { sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";

/** Live authority fixtures must share PostgreSQL's clock: a frozen JS clock
 * cannot exercise constraints that intentionally use clock_timestamp(). */
export async function databaseNow(db: Executor): Promise<Date> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT clock_timestamp()::text AS now`);
  if (!rows[0]) throw new Error("database clock did not return a timestamp");
  return new Date(rows[0].now);
}
