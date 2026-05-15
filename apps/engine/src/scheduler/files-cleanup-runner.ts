// Global runner for the unified-files cleanup cron.
//
// Wave B Step 9 of the unified-files PR. Fires every hour from the
// scheduler reconciler and walks three sweeps in order:
//
//   1) Pending orphans. A presigned-upload row that never got finalized
//      (status='pending') and whose presign URL has been expired for at
//      least an hour is hard-deleted along with any partial object the
//      client may have written. `FILE_DELETED { reason:'pending_expired' }`
//      is emitted per row.
//
//   2) Unlinked TTL. A `status='ready'` row with no `file_links` referers
//      AND no in-flight workflow run referencing the fid is soft-deleted
//      (`deleted_at = now()`). Rows whose `deleted_at` is older than 7
//      days are then hard-deleted together with the storage object;
//      `FILE_DELETED { reason:'unlinked_ttl' }` is emitted per row.
//
//      The in-flight guard is the R10 safety net: a workflow run holding
//      a `$file` ref mid-execution must NOT have its bytes reaped. We
//      implement it as a two-pass check rather than a brittle
//      jsonb_path_query subquery — first SELECT candidate fids, then
//      filter out fids that appear in the union of three in-flight
//      haystacks: `executions.source_ref` (draft + step runs),
//      `execution_steps.input_preview` joined to running executions
//      (saved runs' runtime trail), and `pgboss.job.data` for queued
//      `execution.run` jobs (catches the dispatch-but-not-yet-running
//      window). The soft-delete + 7-day grace bounds the cost of a
//      missed-link.
//
//   3) LLM provider expiry. Provider-side Files API ids (Anthropic /
//      OpenAI / Gemini) come with a finite TTL. When `llm_file_expires_at`
//      has passed we null out the provider ids + the expiry timestamp so
//      the LLM context layer re-uploads the bytes on the next turn. No
//      audit row — this is low-value housekeeping churn.
//
// Best-effort `objectStore.delete`: a failure to remove the backing
// object logs and continues; the sweep does not abort. Leaving an
// orphan blob in the bucket is preferable to wedging the cron.

import { and, count, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db } from "../db/client.ts";
import { executionSteps, executions, fileLinks, files } from "../db/schema/index.ts";
import { storageKey } from "../files/resolver.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { setFilesBytesTotal, setFilesTotal } from "../observability/instrumentation.ts";
import { EXECUTION_RUN_QUEUE } from "../queue/queues.ts";
import { getObjectStore } from "../storage/object-store.ts";

/** Hard-delete window for `deleted_at` rows. Matches the 7-day grace
 *  documented in the unified-files plan (R10 / C15). */
const UNLINKED_HARD_DELETE_AFTER = sql`interval '7 days'`;

/** Pending presigned uploads get reaped one hour after their URL
 *  expires. The extra hour absorbs clock skew between the engine and
 *  S3 / the local presign minter. */
const PENDING_EXPIRY_GRACE = sql`interval '1 hour'`;

/**
 * Best-effort `objectStore.delete`. Logs and swallows on failure —
 * leaving an orphan blob is preferable to aborting the sweep.
 */
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

/**
 * Sweep 1 — pending orphans.
 *
 * Hard-delete `status='pending'` rows whose presign URL expired more
 * than an hour ago. For each row emit `FILE_DELETED` with
 * `reason='pending_expired'` and best-effort remove any partial object
 * the client may have written before abandoning the upload.
 */
async function sweepPendingOrphans(db: Db): Promise<number> {
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
        metadata: { reason: "pending_expired", file_id: row.id },
      },
      db,
    );
  }
  return deleted.length;
}

/**
 * Build the set of fids referenced by any in-flight execution.
 *
 * Two-pass equivalent of the plan's `run_input::text ~ '\bfid_<uuid>\b'`
 * subquery. We materialise three sources of in-flight state into one
 * concatenated haystack, then test each candidate fid via substring
 * match. The set is recomputed per cron tick so a long-running workflow
 * that picks up a fid AFTER the cron began is still protected on the
 * next tick — and the soft-delete grace bounds the cost of any miss.
 *
 * The three sources are unioned because saved-workflow runs go down a
 * different code path than draft / step runs:
 *
 *   1. `executions.source_ref` — populated for draft + step runs
 *      (the inline definition rides on the row). Saved runs set this
 *      to NULL: their definition lives in `workflow_versions` and the
 *      run input arrives via the pg-boss envelope. See
 *      `apps/engine/src/execution/resolve-definition.ts`.
 *
 *   2. `execution_steps.input_preview` — the runtime trail for ANY
 *      in-flight run (saved, draft, step). Each step's resolved input
 *      is stamped here at dispatch time, so a fid that the workflow
 *      pulled in via a `$file` placeholder shows up before the bytes
 *      are read. This is the saved-run safety net for R10.
 *
 *   3. `pgboss.job.data` (queue=`execution.run`, state in created /
 *      active / retry) — catches the queued-but-not-yet-running
 *      window. The `ExecutionRunJob.input` body lives on the job
 *      envelope. Without this scan a freshly-enqueued saved run could
 *      have its fid reaped before the worker even picks the job up.
 *
 * Conservative by design: a fid mentioned in audit metadata or
 * unrelated jsonb would also protect the row, but R10 prefers a false
 * positive (keep the file) over a false negative (reap a file the
 * workflow is reading).
 */
async function loadInFlightFidStrings(db: Db): Promise<string> {
  const parts: string[] = [];

  // Source 1 — running executions' source_ref (draft + step runs).
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

  // Source 2 — execution_steps.input_preview for any step whose parent
  // execution is still running. This is the saved-workflow path:
  // saved runs leave `source_ref=null` but stamp their resolved input
  // here as each step dispatches.
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

  // Source 3 — pg-boss job envelope for execution.run jobs that are
  // queued but not yet running (`created`, `active`, `retry`). The
  // `pgboss` schema is the pg-boss canonical schema; `job.data` holds
  // the `ExecutionRunJob` payload (input lives there for saved runs).
  // Failed jobs (`failed`, `expired`, `cancelled`, `completed`) are
  // excluded — those file refs are no longer in-flight.
  try {
    const jobRows = await db.execute<{ data: string | null }>(sql`
      SELECT data::text AS data
      FROM pgboss.job
      WHERE name = ${EXECUTION_RUN_QUEUE}
        AND state IN ('created', 'active', 'retry')
    `);
    // drizzle's `execute()` return shape varies by driver; normalise.
    const rows: Array<{ data: string | null }> = Array.isArray(jobRows)
      ? (jobRows as unknown as Array<{ data: string | null }>)
      : ((jobRows as unknown as { rows?: Array<{ data: string | null }> }).rows ?? []);
    for (const r of rows) {
      if (r.data != null) parts.push(r.data);
    }
  } catch (err) {
    // pg-boss schema may not exist in some test contexts; degrade
    // gracefully — the executions + execution_steps scans above still
    // protect the dominant in-flight paths.
    logger.warn({
      module: "scheduler",
      action: "files_cleanup.pgboss_scan_failed",
      msg: "pg-boss job scan failed — relying on executions + execution_steps for in-flight grace",
      ...errorFields(err),
    });
  }

  return parts.join("\n");
}

/**
 * Sweep 2 — unlinked TTL.
 *
 * First soft-deletes ready rows with no `file_links` referers and no
 * in-flight execution reference, then hard-deletes any row whose
 * `deleted_at` is older than the 7-day grace. The grace covers the R10
 * "workflow run picks up a fid mid-cron" race — the read path through
 * `requireFileForTenant` ignores `deleted_at`, so the workflow finishes
 * before the bytes go away.
 */
async function sweepUnlinkedTtl(db: Db): Promise<{ soft: number; hard: number }> {
  // ---- Soft-delete pass --------------------------------------------------
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
    const inFlightHaystack = await loadInFlightFidStrings(db);
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

  // ---- Hard-delete pass --------------------------------------------------
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
        metadata: { reason: "unlinked_ttl", file_id: row.id },
      },
      db,
    );
  }
  return { soft: softDeleted, hard: hardDeleted.length };
}

/**
 * Sweep 3 — LLM provider expiry.
 *
 * Null out the per-provider Files API ids when their TTL has passed so
 * the LLM context layer re-uploads on the next turn. No audit row —
 * provider TTLs roll every few days and the churn would dominate the
 * audit ledger without operator value.
 */
async function sweepLlmProviderExpiry(db: Db): Promise<number> {
  // tenant-filter:exempt — global sweep
  const updated = await db
    .update(files)
    .set({
      anthropic_file_id: null,
      openai_file_id: null,
      gemini_file_id: null,
      llm_file_expires_at: null,
    })
    .where(lt(files.llm_file_expires_at, sql`now()`))
    .returning({ id: files.id });
  return updated.length;
}

/**
 * Sweep 4 — refresh `subkit_files_total{tenant_id,status}` and
 * `subkit_files_bytes_total{tenant_id}` gauges.
 *
 * Single GROUP BY pass that bundles row count + size sum per
 * (tenant_id, status). Only live rows (deleted_at IS NULL) participate
 * — soft-deleted rows are accounted out of the live size budget so the
 * gauge tracks "bytes the operator can think of as on-disk for this
 * tenant". Hourly cadence is precise enough for an SLO panel; the route
 * handlers don't need to bump deltas.
 */
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

/**
 * Run all three sweeps in order. Each sweep catches its own errors so
 * a transient failure in sweep N does not block sweeps N+1..3 from
 * running this tick. The cron is scheduled at hour resolution so even
 * a fully-failed tick costs only a one-hour delay.
 */
export async function runFilesCleanup(started: Date, db: Db): Promise<void> {
  const tickId = started.toISOString();
  let pending_deleted = 0;
  let unlinked_soft = 0;
  let unlinked_hard = 0;
  let llm_expired = 0;

  try {
    pending_deleted = await sweepPendingOrphans(db);
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
    llm_expired = await sweepLlmProviderExpiry(db);
  } catch (err) {
    logger.error({
      module: "scheduler",
      action: "files_cleanup.llm_expiry_failed",
      msg: "LLM provider expiry sweep failed",
      tick_id: tickId,
      ...errorFields(err),
    });
  }

  // Gauge refresh runs after the row-mutating sweeps so the snapshot
  // reflects the post-sweep live set. Failure here is non-fatal — the
  // gauges keep their last value until the next tick.
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
    unlinked_soft,
    unlinked_hard,
    llm_expired,
    duration_ms,
  });
}
