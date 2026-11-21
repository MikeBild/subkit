import { sql } from "drizzle-orm";
import { scrubAuditEntry } from "../audit/scrub.ts";
import type { AuditEntry } from "../audit/types.ts";
import { logger } from "../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../observability/metrics.ts";
import { type Executor, getDb } from "./client.ts";
import { auditLog } from "./schema/audit.ts";

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

  try {
    getMetrics().inc(METRIC_NAMES.AUDIT_ROWS_WRITTEN_TOTAL, {
      action: entry.action,
      result: entry.result,
    });
  } catch {}
}

export { sql };
