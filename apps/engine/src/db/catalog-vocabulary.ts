import { sql } from "drizzle-orm";
import { logger } from "../logging/logger.ts";
import type { Transaction } from "./client.ts";

export class CatalogVocabularyBusyError extends Error {
  readonly code = "40001";
}

const catalogLockKey = (tenant_id: string) => sql`hashtextextended(${tenant_id}::text, 741937)`;

function isLockNotAvailable(error: unknown, depth = 0): boolean {
  if (depth > 4 || !error || typeof error !== "object") return false;
  if ("code" in error && error.code === "55P03") return true;
  return "cause" in error && isLockNotAvailable(error.cause, depth + 1);
}

export async function lockCatalogVocabulary(
  exec: Transaction,
  tenant_id: string,
  timeoutMs = 1500,
): Promise<void> {
  const started = performance.now();
  const prior = await exec.execute<{ lock_timeout: string }>(
    sql`SELECT current_setting('lock_timeout') AS lock_timeout`,
  );
  const restore = prior.rows[0]?.lock_timeout ?? "0";
  await exec.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
  try {
    await exec.execute(sql`SELECT pg_advisory_xact_lock(${catalogLockKey(tenant_id)})`);
  } catch (error) {
    if (process.env.SUBKIT_DIAGNOSTICS === "1")
      logger.info({
        module: "db",
        action: "diagnostics.catalog_lock.failed",
        tenant_id,
        duration_ms: performance.now() - started,
        timeout_ms: timeoutMs,
        lock_timeout: isLockNotAvailable(error),
      });
    if (!isLockNotAvailable(error)) throw error;
    throw new CatalogVocabularyBusyError("Catalog vocabulary stayed busy; retry the operation", {
      cause: error,
    });
  }
  await exec.execute(sql`SELECT set_config('lock_timeout', ${restore}, true)`);
  if (process.env.SUBKIT_DIAGNOSTICS === "1")
    logger.info({
      module: "db",
      action: "diagnostics.catalog_lock.acquired",
      tenant_id,
      duration_ms: performance.now() - started,
      timeout_ms: timeoutMs,
    });
}
