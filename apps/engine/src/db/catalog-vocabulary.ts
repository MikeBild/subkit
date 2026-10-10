import { sql } from "drizzle-orm";
import type { Executor } from "./client.ts";

export async function lockCatalogVocabulary(exec: Executor, tenant_id: string): Promise<void> {
  const result = await exec.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${tenant_id}::text, 741937)) AS locked`,
  );
  if (result.rows[0]?.locked) return;
  throw Object.assign(new Error("Catalog vocabulary changed concurrently; retry the operation"), {
    code: "40001",
  });
}
