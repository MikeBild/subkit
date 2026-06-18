// Append-only audit writer. ONE exported function: `writeAudit`. No update.
// No delete. No select helpers. Read-side lives in a separate module (P3+).
//
// The row's id is the idempotency key — `ON CONFLICT DO NOTHING` makes
// retries safe. The unique PK constraint on `audit_log.id` enforces this.

import { sql } from "drizzle-orm";
import type { AuditEntry } from "../audit/types.ts";
import { logger } from "../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { type Executor, getDb } from "./client.ts";
import { auditLog } from "./schema/audit.ts";

/**
 * Persist an AuditEntry to `audit_log`. Accepts any drizzle executor
 * (a db handle or an in-progress transaction) so callers can bind the
 * write to a domain transaction.
 *
 * This function is the only writer for `audit_log`. No update / delete
 * path is exported from this module by design.
 */
export async function writeAudit(entry: AuditEntry, executor?: Executor): Promise<void> {
  const exec: Executor = executor ?? getDb();

  await exec
    .insert(auditLog)
    .values({
      id: entry.id,
      ts: entry.ts,
      tenant_id: entry.tenant_id,
      actor_type: entry.actor_type,
      actor_id: entry.actor_id,
      action: entry.action,
      resource_type: entry.resource_type,
      resource_id: entry.resource_id,
      result: entry.result,
      trace_id: entry.trace_id || null,
      ip: entry.ip,
      user_agent: entry.user_agent,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason,
      metadata: entry.metadata,
    })
    .onConflictDoNothing({ target: auditLog.id });

  logger.debug({
    module: "db",
    action: "audit.written",
    msg: "audit row persisted",
    audit_id: entry.id,
    tenant_id: entry.tenant_id,
    audit_action: entry.action,
  });

  // Metrics — bump only after the insert is durable, so the counter
  // reflects what's actually on disk (including ON CONFLICT DO NOTHING
  // retries, which are still a successful outcome from the caller's
  // point of view — the row is present either way).
  try {
    getMetrics().inc(METRIC_NAMES.AUDIT_ROWS_WRITTEN_TOTAL, {
      action: entry.action,
      result: entry.result,
    });
  } catch {
    // metrics are best-effort; never let a collector bug break the write path
  }
}

// Re-export `sql` so consumers of this module never need to reach for
// drizzle-orm internals directly.
export { sql };
