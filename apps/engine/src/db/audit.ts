// Append-only audit writer. ONE exported function: `writeAudit`. No update.
// No delete. No select helpers. Read-side lives in a separate module (P3+).
//
// The row's id is the idempotency key — `ON CONFLICT DO NOTHING` makes
// retries safe. The unique PK constraint on `audit_log.id` enforces this.

import { sql } from "drizzle-orm";
import { scrubAuditEntry } from "../audit/scrub.ts";
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
 * path is exported from this module by design, and the
 * `audit_log has a single writer` invariant
 * (`apps/engine/scripts/audit-invariants.ts`) holds that claim: any other
 * production module reaching `insert(auditLog)` fails the check.
 *
 * The payload is scrubbed HERE, at the insert, not only at the callers.
 * `EngineClient.audit_write` used to be a second writer with its own insert
 * and no scrub (LOCAL-SK-ZWEITER-AUDIT-SCHREIBER); pinning the rule to the
 * SQL statement means a third writer inherits it by construction instead of
 * having to remember. The pass is idempotent, so callers that already
 * scrubbed (everything through `audit()`) pay a no-op walk.
 */
export async function writeAudit(entry: AuditEntry, executor?: Executor): Promise<void> {
  const exec: Executor = executor ?? getDb();
  const safe = scrubAuditEntry(entry);

  await exec
    .insert(auditLog)
    .values({
      id: safe.id,
      ts: safe.ts,
      tenant_id: safe.tenant_id,
      actor_type: safe.actor_type,
      actor_id: safe.actor_id,
      action: safe.action,
      resource_type: safe.resource_type,
      resource_id: safe.resource_id,
      result: safe.result,
      trace_id: safe.trace_id || null,
      ip: safe.ip,
      user_agent: safe.user_agent,
      before: safe.before ?? null,
      after: safe.after ?? null,
      reason: safe.reason,
      metadata: safe.metadata,
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
