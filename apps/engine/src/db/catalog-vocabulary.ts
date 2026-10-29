import { sql } from "drizzle-orm";
import type { Executor } from "./client.ts";

export class CatalogVocabularyBusyError extends Error {
  readonly code = "40001";
}

const catalogLockKey = (tenant_id: string) => sql`hashtextextended(${tenant_id}::text, 741937)`;

export async function lockCatalogVocabulary(exec: Executor, tenant_id: string): Promise<void> {
  const result = await exec.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${catalogLockKey(tenant_id)}) AS locked`,
  );
  if (result.rows[0]?.locked) return;
  throw new CatalogVocabularyBusyError(
    "Catalog vocabulary changed concurrently; retry the operation",
  );
}

function isLockNotAvailable(error: unknown, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== "object") return false;
  if ("code" in error && error.code === "55P03") return true;
  return "cause" in error && isLockNotAvailable(error.cause, depth + 1);
}

/**
 * Queues for the tenant catalog lock instead of failing on the first conflict.
 * Must be the first lock a transaction takes: the waiter then holds nothing another
 * session could wait on, and every other holder uses the non-blocking variant, so
 * no wait cycle can form. The wait is bounded by a transaction-local lock_timeout
 * that is restored afterwards so later row locks keep their usual timeout; a
 * timeout surfaces as CatalogVocabularyBusyError like the non-blocking variant.
 */
export async function waitForCatalogVocabulary(
  exec: Executor,
  tenant_id: string,
  timeoutMs = 1500,
): Promise<void> {
  const prior = await exec.execute<{ lock_timeout: string }>(
    sql`SELECT current_setting('lock_timeout') AS lock_timeout`,
  );
  const restore = prior.rows[0]?.lock_timeout ?? "0";
  await exec.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
  try {
    await exec.execute(sql`SELECT pg_advisory_xact_lock(${catalogLockKey(tenant_id)})`);
  } catch (error) {
    if (!isLockNotAvailable(error)) throw error;
    throw new CatalogVocabularyBusyError("Catalog vocabulary stayed busy; retry the operation", {
      cause: error,
    });
  }
  await exec.execute(sql`SELECT set_config('lock_timeout', ${restore}, true)`);
}
