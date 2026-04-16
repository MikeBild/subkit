// Append-only. No updates. No deletes. Designed for SOC2 / ISO27001 / GDPR
// compliance. Retention policy is handled by an external archive job — this
// module does not delete rows.

import { writeAudit } from "../db/audit.ts";
import type { Db } from "../db/client.ts";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import type { AuditEntry } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Write an immutable audit log entry.
 *
 * Fills in defaults from the async context, mirrors the entry to the
 * runtime logger, and persists it to the `audit_log` table via
 * `writeAudit`. An optional `executor` binds the audit insert to a
 * caller-managed transaction. If omitted, the shared db client is used
 * (fire-and-forget; errors are logged but do not throw out of `audit()`).
 *
 * Compliance guarantee: the `audit_log` table omits `deleted_at` and
 * carries a unique constraint on `id` so that retries are idempotent.
 * There is no update path and no delete path from this module.
 */
function buildEntry(entry: Partial<AuditEntry>): AuditEntry {
  const ctx = getContext();
  const tenantId = entry.tenant_id ?? ctx.tenant_id;
  if (!tenantId) {
    throw new Error(
      "audit(): tenant_id is required. Provide via withContext() or entry.tenant_id.",
    );
  }
  const traceId = entry.trace_id ?? ctx.trace_id ?? "";

  return {
    id: entry.id ?? crypto.randomUUID(),
    ts: entry.ts ?? new Date(),
    tenant_id: tenantId,
    actor_type: entry.actor_type ?? "system",
    actor_id: entry.actor_id ?? null,
    action: entry.action ?? ("system.startup" as AuditEntry["action"]),
    resource_type: entry.resource_type ?? "system",
    resource_id: entry.resource_id ?? null,
    result: entry.result ?? "success",
    trace_id: traceId,
    ip: entry.ip ?? null,
    user_agent: entry.user_agent ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ?? {},
  };
}

function logEntry(filled: AuditEntry): void {
  logger.info({
    module: "audit",
    action: filled.action,
    msg: "audit entry recorded",
    audit_id: filled.id,
    tenant_id: filled.tenant_id,
    actor_type: filled.actor_type,
    actor_id: filled.actor_id,
    resource_type: filled.resource_type,
    resource_id: filled.resource_id,
    result: filled.result,
    reason: filled.reason,
    metadata: filled.metadata,
  });
}

export function audit(entry: Partial<AuditEntry>, executor?: Executor): AuditEntry {
  const filled = buildEntry(entry);
  logEntry(filled);

  // Fire-and-forget persist. If a caller needs the audit row bound to a
  // domain transaction they should call `auditAwait` (or `writeAudit`
  // directly) with the executor they already hold.
  void writeAudit(filled, executor).catch((err) => {
    logger.error({
      module: "audit",
      action: "audit.persist_failed",
      msg: "failed to persist audit row",
      audit_id: filled.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return filled;
}

/**
 * Awaited audit write — for callers that need to guarantee durability
 * before returning (e.g. seed scripts, boot flows, tests).
 */
export async function auditAwait(
  entry: Partial<AuditEntry>,
  executor?: Executor,
): Promise<AuditEntry> {
  const filled = buildEntry(entry);
  logEntry(filled);
  await writeAudit(filled, executor);
  return filled;
}
