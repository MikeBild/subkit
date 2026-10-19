import { and, count, eq, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
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
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { removeStoredFile } from "../files/remove-stored-file.ts";
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

async function sweepPendingOrphans(db: Db): Promise<{ pending: number; stuck_scanning: number }> {
  // tenant-filter:exempt — global cron sweep; per-row audit carries tenant_id
  const eligible = and(
    eq(files.status, "pending"),
    lt(files.upload_url_expires_at, sql`now() - ${PENDING_EXPIRY_GRACE}`),
  );
  // tenant-filter:exempt — global cleanup candidates are rechecked under an exact tenant and row lock before removal.
  const candidates = await db
    .select({ id: files.id, tenant_id: files.tenant_id })
    .from(files)
    .where(eligible);
  const deleted = [];
  for (const candidate of candidates) {
    try {
      const row = await removeStoredFile(
        db,
        candidate.tenant_id,
        candidate.id,
        eligible,
        "pending_expired",
      );
      if (row) deleted.push(row);
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

function hasNoFileLink() {
  return notExists(
    sql`(select 1 from ${fileLinks} where ${fileLinks.file_id}=${files.id} and ${fileLinks.tenant_id}=${files.tenant_id})`,
  );
}

function hasNoProductReference() {
  return sql`not exists (
    select 1 from ${executions} e where e.tenant_id=${files.tenant_id} and e.status in ('queued','running') and (
      strpos(coalesce(e.source_ref::text,''),${files.id}::text)>0 or strpos(coalesce(e.input::text,''),${files.id}::text)>0
      or coalesce(e.input->>'$sensitive','false')='true' or coalesce(e.source_ref->>'$sensitive','false')='true'
    )
  ) and not exists (
    select 1 from ${executionSteps} s join ${executions} e on e.id=s.execution_id and e.tenant_id=s.tenant_id
    where s.tenant_id=${files.tenant_id} and e.status='running' and strpos(coalesce(s.input_preview::text,''),${files.id}::text)>0
  ) and not exists (
    select 1 from ${workflowsSchedules} s join ${workflows} w on w.id=s.workflow_id and w.tenant_id=s.tenant_id
    where s.tenant_id=${files.tenant_id} and strpos(coalesce(s.input::text,''),${files.id}::text)>0
  )`;
}

async function sweepUnlinkedTtl(
  db: Db,
  boss: PgBoss,
  pool: pg.Pool,
  budget: CleanupQueueBudget,
): Promise<{ soft: number; hard: number }> {
  // tenant-filter:exempt — global sweep
  const candidates = await db
    .select({ id: files.id, tenant_id: files.tenant_id })
    .from(files)
    .where(and(eq(files.status, "ready"), isNull(files.deleted_at), hasNoFileLink()));

  const eligible = and(
    lt(files.deleted_at, sql`now() - ${UNLINKED_HARD_DELETE_AFTER}`),
    hasNoFileLink(),
    hasNoProductReference(),
  );
  // tenant-filter:exempt — global cleanup retains tenant and rechecks eligibility under a row lock.
  const hardCandidates = await db
    .select({ id: files.id, tenant_id: files.tenant_id })
    .from(files)
    .where(eligible);
  if (candidates.length === 0 && hardCandidates.length === 0) return { soft: 0, hard: 0 };
  const scan = await loadInFlightFidStrings(db, boss, pool, budget);
  if (scan.pgboss_scan_failed) {
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.unlinked_soft_delete_skipped",
      msg: "Queue scan incomplete; no unlinked files are removed this tick",
    });
    return { soft: 0, hard: 0 };
  }
  const isReferenced = (candidate: { id: string; tenant_id: string }) =>
    scan.blockedTenants.has(candidate.tenant_id) ||
    scan.globalHaystack.includes(candidate.id) ||
    (scan.tenantHaystacks.get(candidate.tenant_id)?.includes(candidate.id) ?? false);
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
            hasNoFileLink(),
            hasNoProductReference(),
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
            hasNoFileLink(),
            hasNoProductReference(),
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

  const hardDeleted = [];
  for (const candidate of hardCandidates) {
    if (isReferenced(candidate)) continue;
    try {
      const row = await removeStoredFile(
        db,
        candidate.tenant_id,
        candidate.id,
        eligible,
        "unlinked_ttl",
      );
      if (row) hardDeleted.push(row);
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
    const r = await sweepUnlinkedTtl(db, boss, pool, budget);
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
