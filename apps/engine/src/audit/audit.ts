// Append-only. No updates. No deletes. Designed for SOC2 / ISO27001 / GDPR
// compliance. Retention policy is handled by an external archive job — this
// module does not delete rows.

import { writeAudit } from "../db/audit.ts";
import type { Executor } from "../db/client.ts";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { scrubAuditEntry } from "./scrub.ts";
import type { AuditEntry } from "./types.ts";

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
  // An actor that authenticated with an exchanged token (RFC 8693, minted
  // from an API key) is the SAME actor as the key — same actor_type and
  // actor_id — so the only trace of the credential path is `via` in the
  // metadata. Emitters that already use `via` for their own meaning (the
  // tool dispatcher's surface) keep it; the credential path then lands in
  // `auth_via` so neither field is overwritten.
  const metadata = withAuthVia(entry.metadata ?? {}, ctx.auth_via);

  // Audit rows are append-only and immutable. A leaked secret in
  // `metadata` / `before` / `after` / `reason` survives forever, so
  // every payload field that can carry user-provided data is scrubbed
  // BEFORE the row is built. The scrubbed copy is what flows to both
  // the structured logger (mirror) and the `audit_log` insert.
  //
  // The rule itself lives in `scrubAuditEntry` and is applied AGAIN by
  // `writeAudit`, the single SQL writer — this call is what keeps the
  // LOGGER mirror clean, that one is what keeps the TABLE clean no
  // matter which writer got there. See `audit/scrub.ts`.
  return scrubAuditEntry({
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
    before: (entry.before ?? null) as AuditEntry["before"],
    after: (entry.after ?? null) as AuditEntry["after"],
    reason: entry.reason ?? null,
    metadata,
  });
}

function withAuthVia(
  metadata: AuditEntry["metadata"],
  via: string | undefined,
): AuditEntry["metadata"] {
  if (!via) return metadata;
  if (!("via" in metadata)) return { ...metadata, via };
  if (metadata.via === via || "auth_via" in metadata) return metadata;
  return { ...metadata, auth_via: via };
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

// In-flight fire-and-forget audit writes, tracked so tests can await them
// deterministically. A fire-and-forget audit otherwise races test assertions
// that count `audit_log` rows (e.g. the operator risk-signal edge audits
// written by `buildOperatorHealthDigest`): under load the write can land after
// a test has already snapshotted the table. The set holds only transient
// promises — each removes itself on settle — so production cost is one add +
// one finally per audit, with no behavioural change. Size is bounded by the
// number of in-flight `writeAudit` calls (i.e. by the DB pool + write timeout):
// it cannot grow without bound unless the DB stalls every write indefinitely,
// which is already the existing fire-and-forget failure mode.
const _pendingAuditWrites = new Map<Promise<unknown>, Executor | undefined>();

export function audit(entry: Partial<AuditEntry>, executor?: Executor): AuditEntry {
  const filled = buildEntry(entry);
  logEntry(filled);

  // Fire-and-forget persist. If a caller needs the audit row bound to a
  // domain transaction they should call `auditAwait` (or `writeAudit`
  // directly) with the executor they already hold.
  const persist = writeAudit(filled, executor).catch((err) => {
    logger.error({
      module: "audit",
      action: "audit.persist_failed",
      msg: "failed to persist audit row",
      audit_id: filled.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  _pendingAuditWrites.set(persist, executor);
  void persist.finally(() => {
    _pendingAuditWrites.delete(persist);
  });

  return filled;
}

/** Test seam: await in-flight fire-and-forget `audit()` writes to settle.
 *  Pass the test's executor to avoid waiting on unrelated suites whose
 *  disposable database may already be closing. Production never calls this. */
export async function _drainAuditWritesForTests(executor?: Executor): Promise<void> {
  // Snapshot, don't loop-until-empty: the map is process-global, so under a
  // full-suite run a background writer (worker, poller from a neighboring
  // suite) can enqueue a new audit every iteration and livelock the drain
  // until the test times out. The documented contract is "await the writes
  // in flight NOW" — a caller's own audit() is registered synchronously
  // before its triggering call returns, so the snapshot always covers it.
  const pending = [..._pendingAuditWrites].flatMap(([write, writeExecutor]) =>
    executor === undefined || writeExecutor === executor ? [write] : [],
  );
  await Promise.allSettled(pending);
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
