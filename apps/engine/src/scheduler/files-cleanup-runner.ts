import { and, count, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  FileDeletedMetadataSchema,
  FileScanCompletedMetadataSchema,
} from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, fileLinks, files } from "../db/schema/index.ts";
import { storageKey } from "../files/resolver.ts";
import { errorFields, logger } from "../logging/logger.ts";
import {
  recordFilesCleanupPgbossScanMissing,
  setFilesBytesTotal,
  setFilesTotal,
} from "../observability/instrumentation.ts";
import { EXECUTION_RUN_QUEUE } from "../queue/queues.ts";
import { getObjectStore } from "../storage/object-store.ts";

const UNLINKED_HARD_DELETE_AFTER = sql`interval '7 days'`;

const PENDING_EXPIRY_GRACE = sql`interval '1 hour'`;

const STUCK_SCAN_GRACE = sql`interval '1 hour'`;

async function bestEffortDeleteObject(storage_uri: string): Promise<void> {
  try {
    const store = getObjectStore();
    await store.delete(storageKey(storage_uri));
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.object_delete_failed",
      msg: "object store delete failed — orphan blob left in bucket",
      storage_uri,
      ...errorFields(err),
    });
  }
}

async function sweepPendingOrphans(db: Db): Promise<{ pending: number; stuck_scanning: number }> {
  // tenant-filter:exempt — global cron sweep; per-row audit carries tenant_id
  const deleted = await db
    .delete(files)
    .where(
      and(
        eq(files.status, "pending"),
        lt(files.upload_url_expires_at, sql`now() - ${PENDING_EXPIRY_GRACE}`),
      ),
    )
    .returning({
      id: files.id,
      tenant_id: files.tenant_id,
      storage_uri: files.storage_uri,
    });

  for (const row of deleted) {
    await bestEffortDeleteObject(row.storage_uri);
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.FILE_DELETED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileDeletedMetadataSchema.parse({
          file_id: row.id,
          reason: "pending_expired",
          request_source: "scheduler",
        }),
      },
      db,
    );
  }

  // tenant-filter:exempt — global cron sweep
  const stuckScanning = await db
    .update(files)
    .set({ status: "failed", scan_result: "timeout" })
    .where(
      and(eq(files.status, "scanning"), lt(files.created_at, sql`now() - ${STUCK_SCAN_GRACE}`)),
    )
    .returning({ id: files.id, tenant_id: files.tenant_id });

  for (const row of stuckScanning) {
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.stuck_scanning_flipped",
      msg: "row stuck in scanning state past grace — flipped to failed",
      file_id: row.id,
      tenant_id: row.tenant_id,
    });
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.FILE_SCAN_COMPLETED,
        resource_type: "file",
        resource_id: row.id,
        result: "error",
        metadata: FileScanCompletedMetadataSchema.parse({
          file_id: row.id,
          verdict: "timeout",
          engine: "scheduler.stuck_scan_timeout",
          request_source: "scheduler",
        }),
      },
      db,
    );
  }

  return { pending: deleted.length, stuck_scanning: stuckScanning.length };
}

interface InFlightFidScan {
  haystack: string;
  pgboss_scan_failed: boolean;
}

async function loadInFlightFidStrings(db: Db): Promise<InFlightFidScan> {
  const parts: string[] = [];
  let pgboss_scan_failed = false;

  // tenant-filter:exempt — global sweep; the in-flight set covers every tenant
  const execRows = await db
    .select({
      source_ref: executions.source_ref,
    })
    .from(executions)
    .where(eq(executions.status, "running"));
  for (const r of execRows) {
    if (r.source_ref != null) parts.push(JSON.stringify(r.source_ref));
  }

  // tenant-filter:exempt — global sweep
  const stepRows = await db
    .select({
      input_preview: executionSteps.input_preview,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(eq(executions.status, "running"));
  for (const r of stepRows) {
    if (r.input_preview != null) parts.push(JSON.stringify(r.input_preview));
  }

  try {
    const pgbossRows = await db.execute<{ data: string | null }>(sql`
      SELECT data::text AS data
      FROM pgboss.job
      WHERE name = ${EXECUTION_RUN_QUEUE}
        AND state IN ('created', 'active', 'retry')
      UNION ALL
      SELECT data::text AS data
      FROM pgboss.schedule
    `);
    const rows: Array<{ data: string | null }> = Array.isArray(pgbossRows)
      ? (pgbossRows as unknown as Array<{ data: string | null }>)
      : ((pgbossRows as unknown as { rows?: Array<{ data: string | null }> }).rows ?? []);
    for (const r of rows) {
      if (r.data != null) parts.push(r.data);
    }
  } catch (err) {
    pgboss_scan_failed = true;
    recordFilesCleanupPgbossScanMissing({ source: "job" });
    recordFilesCleanupPgbossScanMissing({ source: "schedule" });
    logger.error({
      module: "scheduler",
      action: "files_cleanup.pgboss_scan_failed",
      msg: "pg-boss in-flight scan failed — deploy regression in production; unlinked-TTL soft-delete pass skipped this tick",
      ...errorFields(err),
    });
  }

  return { haystack: parts.join("\n"), pgboss_scan_failed };
}

async function sweepUnlinkedTtl(db: Db): Promise<{ soft: number; hard: number }> {
  // tenant-filter:exempt — global sweep
  const candidates = await db
    .select({ id: files.id, tenant_id: files.tenant_id })
    .from(files)
    .where(
      and(
        eq(files.status, "ready"),
        isNull(files.deleted_at),
        notInArray(files.id, db.select({ file_id: fileLinks.file_id }).from(fileLinks)),
      ),
    );

  let softDeleted = 0;
  if (candidates.length > 0) {
    const scan = await loadInFlightFidStrings(db);
    if (scan.pgboss_scan_failed) {
      logger.warn({
        module: "scheduler",
        action: "files_cleanup.unlinked_soft_delete_skipped",
        msg: "skipping unlinked-TTL soft-delete pass — pg-boss scan unreachable; in-flight files cannot be guarded this tick",
      });
    } else {
      const inFlightHaystack = scan.haystack;
      const toSoftDelete = candidates
        .filter((c) => !inFlightHaystack.includes(c.id))
        .map((c) => c.id);
      if (toSoftDelete.length > 0) {
        const updated = await db
          .update(files)
          .set({ deleted_at: new Date() })
          .where(and(inArray(files.id, toSoftDelete), isNull(files.deleted_at)))
          .returning({ id: files.id });
        softDeleted = updated.length;
      }
    }
  }

  // tenant-filter:exempt — global sweep; per-row audit carries tenant_id
  const hardDeleted = await db
    .delete(files)
    .where(lt(files.deleted_at, sql`now() - ${UNLINKED_HARD_DELETE_AFTER}`))
    .returning({
      id: files.id,
      tenant_id: files.tenant_id,
      storage_uri: files.storage_uri,
    });

  for (const row of hardDeleted) {
    await bestEffortDeleteObject(row.storage_uri);
    await auditAwait(
      {
        tenant_id: row.tenant_id,
        actor_type: "system",
        actor_id: null,
        action: AuditAction.FILE_DELETED,
        resource_type: "file",
        resource_id: row.id,
        result: "success",
        metadata: FileDeletedMetadataSchema.parse({
          file_id: row.id,
          reason: "unlinked_ttl",
          request_source: "scheduler",
        }),
      },
      db,
    );
  }
  return { soft: softDeleted, hard: hardDeleted.length };
}

async function refreshFilesGauges(db: Db): Promise<void> {
  // tenant-filter:exempt — global sweep, gauge labels include tenant_id
  const rows = await db
    .select({
      tenant_id: files.tenant_id,
      status: files.status,
      n: count(),
      bytes: sql<string | number>`COALESCE(SUM(${files.size_bytes}), 0)`,
    })
    .from(files)
    .where(isNull(files.deleted_at))
    .groupBy(files.tenant_id, files.status);

  const bytesByTenant = new Map<string, number>();
  for (const r of rows) {
    setFilesTotal({
      tenant_id: r.tenant_id,
      status: r.status,
      value: Number(r.n),
    });
    const prior = bytesByTenant.get(r.tenant_id) ?? 0;
    bytesByTenant.set(r.tenant_id, prior + Number(r.bytes));
  }
  for (const [tenant_id, value] of bytesByTenant.entries()) {
    setFilesBytesTotal({ tenant_id, value });
  }
}

export async function runFilesCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let pending_deleted = 0;
  let stuck_scanning_flipped = 0;
  let unlinked_soft = 0;
  let unlinked_hard = 0;

  try {
    const r = await sweepPendingOrphans(db);
    pending_deleted = r.pending;
    stuck_scanning_flipped = r.stuck_scanning;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "files_cleanup.pending_failed",
      msg: "pending-orphan sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  try {
    const r = await sweepUnlinkedTtl(db);
    unlinked_soft = r.soft;
    unlinked_hard = r.hard;
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "files_cleanup.unlinked_failed",
      msg: "unlinked-TTL sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  try {
    await refreshFilesGauges(db);
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.gauges_refresh_failed",
      msg: "files gauge refresh failed — gauges retain prior values",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  const duration_ms = Date.now() - started.getTime();
  logger.info({
    module: "scheduler",
    action: "files_cleanup.fired",
    msg: "files cleanup cron pass completed",
    tick_id: tickId,
    pending_deleted,
    stuck_scanning_flipped,
    unlinked_soft,
    unlinked_hard,
    duration_ms,
  });
}
