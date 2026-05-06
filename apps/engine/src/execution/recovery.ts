// Engine boot-time crash recovery.
//
// Scenario: the engine process exits hard (OOM kill, kernel panic,
// SIGKILL from the orchestrator) while one or more executions are
// `status='running'`. Without a sweep, those rows are stuck forever —
// the worker that owned them is gone, no one will ever flip them to a
// terminal state, and the API surface keeps reporting them as live.
//
// On boot we SELECT every `running` execution whose `started_at` is
// older than `workflow.timeout_ms × 1.5` (defaulting to 6h × 1.5 = 9h
// when the workflow has no explicit timeout). Each row is forced to
// `timed_out` inside a transaction that:
//   - asserts `status='running'` in the WHERE so a concurrent engine
//     instance racing the same row loses cleanly (RETURNING is empty,
//     we skip).
//   - writes the `execution.timed_out` outbox event so the existing
//     notification pipeline can fan out alerts.
//   - emits an `execution.crash_recovered` audit row with the timing
//     context (`started_at`, `recovered_at`, `timeout_ms`,
//     `actor_type: "system"`) so compliance tooling can see crashes
//     without reading structured logs.
//
// The sweep is bounded to LIMIT 1000 per call so a pathological backlog
// after a long outage cannot blow out memory. Subsequent reconciler
// passes will pick up anything left behind.

import { eq, sql } from "drizzle-orm";
import { recordExecutionCrashRecovered } from "../audit/recorders/index.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executions, workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";

/** 6h default — the upper bound used when no workflow timeout is set. */
const DEFAULT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Multiplier applied to `workflow.timeout_ms` to define the crash-grace window. */
const CRASH_GRACE_MULTIPLIER = 1.5;
/** Cap one sweep pass at this many rows so a backlog cannot OOM the boot. */
const MAX_RECOVER_PER_PASS = 1000;

export interface RecoverCrashedExecutionsOptions {
  now?: Date;
  /**
   * Per-tenant override threshold in ms. If provided and positive,
   * trumps the per-workflow `timeout_ms × 1.5` calculation. Useful for
   * an env-var fallback (see `resolveCrashRecoveryThresholdMs`).
   * The override is a hard cap on the grace window — callers that want
   * "never reap" should not call this function.
   */
  overrideThresholdMs?: number;
}

export interface RecoverCrashedExecutionsResult {
  recovered: number;
}

/**
 * Resolve the recovery threshold in ms from env. The default is a
 * defensive 9h (6h × 1.5) — long enough that a healthy long-running
 * execution never gets reaped by mistake, short enough that a crashed
 * one is cleared by the next boot rather than lingering for a week.
 */
export function resolveCrashRecoveryThresholdMs(envValue: string | undefined): number | undefined {
  if (!envValue) return undefined;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  workflow_id: string | null;
  started_at: Date | null;
  /** Pulled from `workflow_versions.dag->>timeout_ms` — may be null. */
  workflow_timeout_ms: number | null;
}

/**
 * Boot-time sweep. Promotes every stuck `running` execution to
 * `timed_out` and emits the matching audit + outbox events. Returns
 * the count of rows promoted so the caller can log it.
 */
export async function recoverCrashedExecutions(
  db: Db,
  opts: RecoverCrashedExecutionsOptions = {},
): Promise<RecoverCrashedExecutionsResult> {
  const now = opts.now ?? new Date();

  // Candidate select. We pull the workflow's `timeout_ms` out of the
  // dag JSON of the workflow's *current_version_id* — falling back to
  // the default when the field is missing. The threshold is computed
  // per-row in JS (not SQL) so the override and the multiplier stay
  // visible at the call site rather than buried inside an INTERVAL
  // expression.
  // tenant-filter:exempt — recovery sweeps every tenant on resume
  const candidates = (await db
    .select({
      id: executions.id,
      tenant_id: executions.tenant_id,
      workflow_id: executions.workflow_id,
      started_at: executions.started_at,
      workflow_timeout_ms: sql<
        number | null
      >`NULLIF(${workflowVersions.dag}->>'timeout_ms', '')::int`,
    })
    .from(executions)
    .leftJoin(workflows, eq(workflows.id, executions.workflow_id))
    .leftJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(eq(executions.status, "running"))
    .limit(MAX_RECOVER_PER_PASS)) as CandidateRow[];

  if (candidates.length === 0) {
    return { recovered: 0 };
  }

  let recovered = 0;
  for (const row of candidates) {
    if (!row.started_at) continue; // can't classify without a start time
    const baseTimeout = row.workflow_timeout_ms ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
    const thresholdMs = opts.overrideThresholdMs ?? baseTimeout * CRASH_GRACE_MULTIPLIER;
    const ageMs = now.getTime() - row.started_at.getTime();
    if (ageMs < thresholdMs) continue;

    try {
      const flipped = await db.transaction(async (tx) => {
        const updated = await tx
          .update(executions)
          .set({
            status: "timed_out",
            finished_at: now,
          })
          // status='running' is repeated in the WHERE so a competing
          // engine instance that already promoted this row loses the
          // race cleanly (the UPDATE returns no rows and we skip).
          .where(sql`${executions.id} = ${row.id} AND ${executions.status} = 'running'`)
          .returning({ id: executions.id });
        if (updated.length === 0) return false;
        await writeEvent(tx, {
          tenant_id: row.tenant_id,
          channel: "execution.status",
          type: "execution.timed_out",
          payload: {
            execution_id: row.id,
            status: "timed_out",
            reason: "engine_crash_recovery",
          },
        });
        return true;
      });
      if (!flipped) continue;

      await recordExecutionCrashRecovered({
        tenant_id: row.tenant_id,
        actor_id: null,
        actor_type: "system",
        execution_id: row.id,
        workflow_id: row.workflow_id,
        reason: "engine_crash_recovery",
        metadata: {
          actor_type: "system",
          started_at: row.started_at.toISOString(),
          recovered_at: now.toISOString(),
          timeout_ms: thresholdMs,
          workflow_timeout_ms: row.workflow_timeout_ms,
          age_ms: ageMs,
          source: "boot_recovery",
        },
        // Bind the audit insert to the caller's db handle so tests
        // using a disposable per-file database land the row in the
        // SAME db the executions row lives on. In production this is
        // the shared engine db (same as `getDb()`).
        executor: db,
      });

      recovered += 1;
      logger.info({
        module: "execution",
        action: "crash_recovery.row",
        msg: "execution forced to timed_out by crash recovery sweep",
        execution_id: row.id,
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        started_at: row.started_at.toISOString(),
        age_ms: ageMs,
        threshold_ms: thresholdMs,
      });
    } catch (err) {
      // One bad row must not abort the sweep — log and continue.
      logger.error({
        module: "execution",
        action: "crash_recovery.row_failed",
        msg: "crash recovery failed for one execution",
        execution_id: row.id,
        tenant_id: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { recovered };
}
