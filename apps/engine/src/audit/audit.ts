import { writeAudit } from "../db/audit.ts";
import type { Executor } from "../db/client.ts";
import { getContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { scrubAuditEntry } from "./scrub.ts";
import type { AuditEntry } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeAuditActorId(actorId: string | null | undefined): string | null {
  return actorId && UUID_RE.test(actorId) ? actorId : null;
}

function buildEntry(entry: Partial<AuditEntry>): AuditEntry {
  const ctx = getContext();
  const tenantId = entry.tenant_id ?? ctx.tenant_id;
  if (!tenantId) {
    throw new Error(
      "audit(): tenant_id is required. Provide via withContext() or entry.tenant_id.",
    );
  }
  const traceId = entry.trace_id ?? ctx.trace_id ?? "";
  const sensitive = ctx.execution_privacy === "sensitive";
  const metadata = withAuthVia(
    sensitive
      ? {
          execution_privacy: "sensitive",
          ...(ctx.execution_id ? { execution_id: ctx.execution_id } : {}),
        }
      : (entry.metadata ?? {}),
    ctx.auth_via,
  );
  return scrubAuditEntry({
    id: entry.id ?? crypto.randomUUID(),
    ts: entry.ts ?? new Date(),
    tenant_id: tenantId,
    actor_type: entry.actor_type ?? "system",
    actor_id: normalizeAuditActorId(entry.actor_id),
    action: entry.action ?? ("system.startup" as AuditEntry["action"]),
    resource_type: entry.resource_type ?? "system",
    resource_id: entry.resource_id ?? null,
    result: entry.result ?? "success",
    trace_id: traceId,
    ip: entry.ip ?? null,
    user_agent: entry.user_agent ?? null,
    before: (sensitive ? null : (entry.before ?? null)) as AuditEntry["before"],
    after: (sensitive ? null : (entry.after ?? null)) as AuditEntry["after"],
    reason: sensitive && entry.reason ? "sensitive_execution" : (entry.reason ?? null),
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

const _pendingAuditWrites = new Map<Promise<unknown>, Executor | undefined>();

export function audit(entry: Partial<AuditEntry>, executor?: Executor): AuditEntry {
  const filled = buildEntry(entry);
  logEntry(filled);

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

export async function _drainAuditWritesForTests(executor?: Executor): Promise<void> {
  const pending = [..._pendingAuditWrites].flatMap(([write, writeExecutor]) =>
    executor === undefined || writeExecutor === executor ? [write] : [],
  );
  await Promise.allSettled(pending);
}

export async function auditAwait(
  entry: Partial<AuditEntry>,
  executor?: Executor,
): Promise<AuditEntry> {
  const filled = buildEntry(entry);
  logEntry(filled);
  await writeAudit(filled, executor);
  return filled;
}
