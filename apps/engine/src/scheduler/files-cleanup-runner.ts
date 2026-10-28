import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { AuditAction, auditAwait, FileScanCompletedMetadataSchema } from "../audit/index.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import { type Db, getPool } from "../db/client.ts";
import {
  executionSteps,
  executions,
  fileLinks,
  files,
  packageInstalls,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { findRetainedFileReferences } from "../files/reference-protection.ts";
import { removeStoredFile } from "../files/remove-stored-file.ts";
import { PACKAGE_CONTENT_TYPE } from "../identity/portability/format.ts";
import { errorFields, logger } from "../logging/logger.ts";
import {
  recordFilesCleanupPgbossScanMissing,
  setFilesBytesTotal,
  setFilesTotal,
} from "../observability/instrumentation.ts";
import {
  CLEANUP_QUEUE_BUDGET,
  type CleanupQueueBudget,
  loadCleanupQueuePayloads,
} from "./cleanup-queue-reader.ts";

const UNLINKED_HARD_DELETE_AFTER = sql`interval '7 days'`;

const PENDING_EXPIRY_GRACE = sql`interval '1 hour'`;

const STUCK_SCAN_GRACE = sql`interval '1 hour'`;

const PACKAGE_ARCHIVE_MIN_AGE = sql`interval '1 day'`;

export const FILES_CLEANUP_BATCH_SIZE = 256;
export const FILES_UNLINKED_CLEANUP_BATCH_SIZE = 16;
type CleanupPass = "pending" | "soft" | "hard";
const cleanupPositions = new WeakMap<Db, Partial<Record<CleanupPass, string>>>();

async function cleanupCandidates(
  db: Db,
  pass: CleanupPass,
  eligible: SQL | undefined,
  limit = FILES_CLEANUP_BATCH_SIZE,
) {
  const positions = cleanupPositions.get(db) ?? {};
  cleanupPositions.set(db, positions);
  // tenant-filter:exempt — bounded global cleanup keys retain tenant ownership for exact mutation-time rechecks.
  const select = (after?: string) =>
    db
      .select({
        id: files.id,
        tenant_id: files.tenant_id,
        slug: files.slug,
        content_type: files.content_type,
      })
      .from(files)
      .where(and(eligible, after ? gt(files.id, after) : undefined))
      .orderBy(asc(files.id))
      .limit(limit)
      .for("update", { skipLocked: true });
  let rows = await select(positions[pass]);
  if (rows.length === 0 && positions[pass]) {
    delete positions[pass];
    rows = await select();
  }
  const last = rows.at(-1);
  if (last) positions[pass] = last.id;
  return rows;
}

async function sweepPendingOrphans(db: Db): Promise<{ pending: number; stuck_scanning: number }> {
  // tenant-filter:exempt — global cron sweep; per-row audit carries tenant_id
  const eligible = and(
    eq(files.status, "pending"),
    lt(files.upload_url_expires_at, sql`now() - ${PENDING_EXPIRY_GRACE}`),
  );
  const candidates = await cleanupCandidates(db, "pending", eligible);
  let deleted = 0;
  for (const candidate of candidates) {
    try {
      const row = await removeStoredFile(
        db,
        candidate.tenant_id,
        candidate.id,
        eligible,
        "pending_expired",
      );
      if (row) deleted++;
    } catch (err) {
      logger.warn({
        module: "scheduler",
        action: "files_cleanup.object_delete_failed",
        msg: "Object cleanup failed; file reservation retained",
        file_id: candidate.id,
        tenant_id: candidate.tenant_id,
        ...errorFields(err),
      });
    }
  }

  const stuckScanning = await db.transaction(async (tx) => {
    const expired = and(
      eq(files.status, "scanning"),
      lt(files.created_at, sql`now() - ${STUCK_SCAN_GRACE}`),
    );
    // tenant-filter:exempt — bounded global scan-timeout keys retain tenant ownership for atomic guarded updates and audits.
    const candidates = await tx
      .select({ id: files.id, tenant_id: files.tenant_id })
      .from(files)
      .where(expired)
      .orderBy(asc(files.id))
      .limit(FILES_CLEANUP_BATCH_SIZE)
      .for("update", { skipLocked: true });
    let changed = 0;
    for (const row of candidates) {
      const updated = await tx
        .update(files)
        .set({ status: "failed", scan_result: "timeout" })
        .where(and(eq(files.id, row.id), eq(files.tenant_id, row.tenant_id), expired))
        .returning({ id: files.id });
      if (!updated[0]) continue;
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
        tx,
      );
      changed++;
    }
    return changed;
  });

  return { pending: deleted, stuck_scanning: stuckScanning };
}

interface InFlightFidScan {
  tenantHaystacks: Map<string, string>;
  globalHaystack: string;
  blockedTenants: Set<string>;
  pgboss_scan_failed: boolean;
}

async function loadInFlightFidStrings(
  db: Db,
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget,
): Promise<InFlightFidScan> {
  const parts = new Map<string, string[]>();
  const blockedTenants = new Set<string>();
  let globalHaystack = "";
  let pgboss_scan_failed = false;
  try {
    const payloads = await loadCleanupQueuePayloads(boss, pool, budget, async (reader) => {
      // tenant-filter:exempt — global cleanup inventory projects bounded references with owner tenant retained.
      const executionReferences = db
        .select({
          id: executions.id,
          tenant_id: executions.tenant_id,
          payload:
            sql`jsonb_build_object('source_ref',${executions.source_ref},'input',${executions.input},'sensitive',coalesce(${executions.source_ref}->>'$sensitive','false')='true' or coalesce(${executions.input}->>'$sensitive','false')='true')`.as(
              "payload",
            ),
        })
        .from(executions)
        .where(inArray(executions.status, ["queued", "running"]));
      const stepReferences = db
        .select({
          id: executionSteps.id,
          tenant_id: executionSteps.tenant_id,
          payload: sql`jsonb_build_object('input_preview',${executionSteps.input_preview})`.as(
            "payload",
          ),
        })
        .from(executionSteps)
        .innerJoin(
          executions,
          and(
            eq(executions.id, executionSteps.execution_id),
            eq(executions.tenant_id, executionSteps.tenant_id),
          ),
        )
        .where(
          and(eq(executions.tenant_id, executionSteps.tenant_id), eq(executions.status, "running")),
        );
      const scheduleReferences = db
        .select({
          id: workflowsSchedules.id,
          tenant_id: workflowsSchedules.tenant_id,
          payload: sql`jsonb_build_object('input',${workflowsSchedules.input})`.as("payload"),
        })
        .from(workflowsSchedules)
        .innerJoin(
          workflows,
          and(
            eq(workflows.id, workflowsSchedules.workflow_id),
            eq(workflows.tenant_id, workflowsSchedules.tenant_id),
          ),
        )
        .where(eq(workflows.tenant_id, workflowsSchedules.tenant_id));
      for (const source of [executionReferences, stepReferences, scheduleReferences]) {
        const references = source.limit(reader.rowsRemaining + 1).as("cleanup_references");
        const cost = sql`sum(2 * octet_length(${references.payload}::text) + 256) over (order by ${references.id})`;
        // tenant-filter:exempt — bounded global reference inventory retains source tenant IDs for exact mutation-time checks.
        const query = db
          .select({
            tenant_id: references.tenant_id,
            sensitive:
              sql<boolean>`coalesce(${references.payload}->>'sensitive','false')='true'`.as(
                "sensitive",
              ),
            payload: sql<
              string | null
            >`case when ${cost} <= ${reader.bytesRemaining} then ${references.payload}::text else null end`.as(
              "payload",
            ),
          })
          .from(references)
          .orderBy(references.id)
          .toSQL();
        const result = await reader.executeSql(query.sql, query.params);
        for (const row of result.rows) {
          if (typeof row.tenant_id !== "string" || typeof row.payload !== "string")
            throw new Error("files_cleanup_product_inventory_budget_exceeded");
          if (row.sensitive === true) blockedTenants.add(row.tenant_id);
          const entries = parts.get(row.tenant_id) ?? [];
          entries.push(row.payload);
          parts.set(row.tenant_id, entries);
        }
      }
    });
    for (const entry of payloads) {
      if (entry.tenant_id === null) globalHaystack += `\n${entry.payload}`;
      else {
        const entries = parts.get(entry.tenant_id) ?? [];
        entries.push(entry.payload);
        parts.set(entry.tenant_id, entries);
      }
    }
  } catch (err) {
    pgboss_scan_failed = true;
    recordFilesCleanupPgbossScanMissing({ source: "job" });
    recordFilesCleanupPgbossScanMissing({ source: "schedule" });
    logger.error({
      module: "scheduler",
      action: "files_cleanup.pgboss_scan_failed",
      msg: "Queue reference scan incomplete; unlinked cleanup skipped",
      ...errorFields(err),
    });
  }
  return {
    tenantHaystacks: new Map(
      [...parts].map(([tenantId, entries]) => [tenantId, entries.join("\n")]),
    ),
    globalHaystack,
    blockedTenants,
    pgboss_scan_failed,
  };
}

function isNotInstalledPackageArchive(): SQL {
  return notExists(
    sql`(select 1 from ${packageInstalls} where ${packageInstalls.archive_file_id}=${files.id} and ${packageInstalls.tenant_id}=${files.tenant_id})`,
  );
}

function isSettledForCleanup(): SQL {
  return (
    or(
      isNull(files.content_type),
      ne(files.content_type, PACKAGE_CONTENT_TYPE),
      lt(files.created_at, sql`now() - ${PACKAGE_ARCHIVE_MIN_AGE}`),
    ) ?? sql`true`
  );
}

function hasNoFileLink() {
  return notExists(
    sql`(select 1 from ${fileLinks} where ${fileLinks.file_id}=${files.id} and ${fileLinks.tenant_id}=${files.tenant_id})`,
  );
}

async function sweepUnlinkedTtl(
  db: Db,
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget,
): Promise<{ soft: number; hard: number; incomplete: boolean }> {
  return retryTransient(
    async () => {
      try {
        return await sweepUnlinkedTtlPass(db, boss, pool, budget);
      } catch (err) {
        const positions = cleanupPositions.get(db);
        if (positions) {
          delete positions.soft;
          delete positions.hard;
        }
        throw err;
      }
    },
    { tries: 3, startMs: 50, maxMs: 200, label: "files_cleanup_unlinked" },
  );
}

async function sweepUnlinkedTtlPass(
  db: Db,
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget,
): Promise<{ soft: number; hard: number; incomplete: boolean }> {
  const candidates = await cleanupCandidates(
    db,
    "soft",
    and(
      eq(files.status, "ready"),
      isNull(files.deleted_at),
      isSettledForCleanup(),
      isNotInstalledPackageArchive(),
    ),
    FILES_UNLINKED_CLEANUP_BATCH_SIZE,
  );

  const hardSelection = lt(files.deleted_at, sql`now() - ${UNLINKED_HARD_DELETE_AFTER}`);
  const hardCandidates = await cleanupCandidates(
    db,
    "hard",
    and(hardSelection, isNotInstalledPackageArchive()),
    FILES_UNLINKED_CLEANUP_BATCH_SIZE,
  );
  if (candidates.length === 0 && hardCandidates.length === 0)
    return { soft: 0, hard: 0, incomplete: false };
  const scan = await loadInFlightFidStrings(db, boss, pool, budget);
  if (scan.pgboss_scan_failed) {
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.unlinked_soft_delete_skipped",
      msg: "Queue scan incomplete; no unlinked files are removed this tick",
    });
    return { soft: 0, hard: 0, incomplete: true };
  }
  const isQueued = (candidate: { id: string; tenant_id: string }) =>
    scan.blockedTenants.has(candidate.tenant_id) ||
    scan.globalHaystack.includes(candidate.id) ||
    (scan.tenantHaystacks.get(candidate.tenant_id)?.includes(candidate.id) ?? false);
  const retained = await findRetainedFileReferences(
    db,
    [...candidates, ...hardCandidates].filter(
      (candidate) => candidate.content_type !== PACKAGE_CONTENT_TYPE && !isQueued(candidate),
    ),
  );
  const isReferenced = (candidate: { id: string; tenant_id: string }) =>
    isQueued(candidate) || retained.has(candidate.id);
  let softDeleted = 0;
  for (const candidate of candidates) {
    if (isReferenced(candidate)) continue;
    softDeleted += await db.transaction(async (tx) => {
      await lockCatalogVocabulary(tx, candidate.tenant_id);
      await tx.execute(sql`select set_config('statement_timeout','5000',true)`);
      const [locked] = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.tenant_id, candidate.tenant_id),
            eq(files.id, candidate.id),
            eq(files.status, "ready"),
            isNull(files.deleted_at),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return 0;
      const updated = await tx
        .update(files)
        .set({ deleted_at: new Date() })
        .where(
          and(
            eq(files.tenant_id, candidate.tenant_id),
            eq(files.id, candidate.id),
            eq(files.status, "ready"),
            isNull(files.deleted_at),
            isSettledForCleanup(),
            hasNoFileLink(),
            isNotInstalledPackageArchive(),
          ),
        )
        .returning({ id: files.id });
      if (updated.length > 0) {
        await auditAwait(
          {
            tenant_id: candidate.tenant_id,
            actor_type: "system",
            actor_id: null,
            action: AuditAction.FILE_DELETED,
            resource_type: "file",
            resource_id: candidate.id,
            result: "success",
            metadata: { file_id: candidate.id, reason: "unlinked_ttl_soft" },
          },
          tx,
        );
      }
      return updated.length;
    });
  }

  let hardDeleted = 0;
  for (const candidate of hardCandidates) {
    if (isReferenced(candidate)) continue;
    try {
      const row = await removeStoredFile(
        db,
        candidate.tenant_id,
        candidate.id,
        and(hardSelection, hasNoFileLink(), isNotInstalledPackageArchive()),
        "unlinked_ttl",
      );
      if (row) hardDeleted++;
    } catch (err) {
      logger.warn({
        module: "scheduler",
        action: "files_cleanup.object_delete_failed",
        msg: "Object cleanup failed; file reservation retained",
        file_id: candidate.id,
        tenant_id: candidate.tenant_id,
        ...errorFields(err),
      });
    }
  }

  return { soft: softDeleted, hard: hardDeleted, incomplete: false };
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

export async function runFilesCleanup(
  started: Date,
  db: Db,
  boss: PgBoss,
  pool: pg.Pool = getPool(),
  budget: CleanupQueueBudget = CLEANUP_QUEUE_BUDGET,
): Promise<void> {
  const tickId = started.toISOString();
  let pending_deleted = 0;
  let stuck_scanning_flipped = 0;
  let unlinked_soft = 0;
  let unlinked_hard = 0;
  let failed = false;

  try {
    const r = await sweepPendingOrphans(db);
    pending_deleted = r.pending;
    stuck_scanning_flipped = r.stuck_scanning;
  } catch (err) {
    failed = true;
    logger.error({
      module: "scheduler",
      action: "files_cleanup.pending_failed",
      msg: "pending-orphan sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  try {
    const r = await sweepUnlinkedTtl(db, boss, pool, budget);
    unlinked_soft = r.soft;
    unlinked_hard = r.hard;
    failed ||= r.incomplete;
  } catch (err) {
    failed = true;
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
  const summary = {
    module: "scheduler",
    action: failed ? "files_cleanup.failed" : "files_cleanup.fired",
    msg: failed
      ? "files cleanup cron pass finished with error"
      : "files cleanup cron pass completed",
    tick_id: tickId,
    pending_deleted,
    stuck_scanning_flipped,
    unlinked_soft,
    unlinked_hard,
    duration_ms,
  };
  if (failed) logger.warn(summary);
  else logger.info(summary);
}
