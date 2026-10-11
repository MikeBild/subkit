import { sql } from "drizzle-orm";
import type { Executor } from "./client.ts";

export class CatalogVocabularyBusyError extends Error {
  readonly code = "40001";
}

export async function lockCatalogVocabulary(exec: Executor, tenant_id: string): Promise<void> {
  const result = await exec.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${tenant_id}::text, 741937)) AS locked`,
  );
  if (result.rows[0]?.locked) return;
  throw new CatalogVocabularyBusyError(
    "Catalog vocabulary changed concurrently; retry the operation",
  );
}
