// Engine crash recovery.
//
// Scenario: the engine process exits hard (OOM kill, kernel panic,
// SIGKILL from the orchestrator) while one or more executions are
// `status='running'`. Without a sweep, those rows are stuck forever —
// the worker that owned them is gone, no one will ever flip them to a
// terminal state, and the API surface keeps reporting them as live.
//
// On boot and on a periodic reconciliation pass we SELECT every `running`
// execution. A row is terminalized when either a durable abort request is
// present or its `started_at` is older than `workflow.timeout_ms × 1.5`
// (defaulting to 6h × 1.5 = 9h when the workflow has no explicit timeout).
// Abort requests become `aborted`; expired rows become `timed_out`. Each
// transition runs inside a transaction that:
//   - asserts `status='running'` in the WHERE so a concurrent engine
//     instance racing the same row loses cleanly (RETURNING is empty,
//     we skip).
//   - terminalizes any still-running step rows in the same transaction,
//     preserving the execution/step state invariant after a crash.
//   - writes the matching terminal outbox events so the existing
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
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionSteps, executions, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import type { ExecutionStatus } from "./types.ts";

/** 6h default — the upper bound used when no workflow timeout is set. */
const DEFAULT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Multiplier applied to `workflow.timeout_ms` to define the crash-grace window. */
const CRASH_GRACE_MULTIPLIER = 1.5;
/** Cap one sweep pass at this many rows so a backlog cannot OOM the boot. */
const MAX_RECOVER_PER_PASS = 1000;

export interface RecoverCrashedExecutionsOptions {
  now?: Date;
  source?: "boot_recovery" | "periodic_recovery";
  /**
   * Per-tenant override threshold in ms. If provided and positive,
   * trumps the per-workflow `timeout_ms × 1.5` calculation. The runtime
   * setting `queue.crash_recovery_threshold_ms` supplies this when non-zero.
   * The override is a hard cap on the grace window — callers that want
   * "never reap" should not call this function.
   */
  overrideThresholdMs?: number;
}

export interface RecoverCrashedExecutionsResult {
  recovered: number;
  reconciled_steps: number;
}

/**
 * Parse a legacy textual recovery threshold. Retained for migration tooling;
 * production reads the typed runtime setting.
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
  abort_requested_at: Date | null;
  /** Pulled from `workflow_versions.dag->>timeout_ms` — may be null. */
  workflow_timeout_ms: number | null;
}

type TerminalExecutionStatus = Exclude<ExecutionStatus, "queued" | "running">;

interface TerminalExecutionWithRunningStepRow {
  id: string;
  tenant_id: string;
  workflow_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  status: TerminalExecutionStatus;
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
  const source = opts.source ?? "boot_recovery";

  // Candidate select. We pull the workflow's `timeout_ms` out of the
  // dag JSON of the exact workflow version bound to the execution — falling
  // back to the default when the field is missing. Reading the workflow's
  // current version here would let a later edit silently change the timeout
  // contract of an already-running execution. The threshold is computed
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
      abort_requested_at: executions.abort_requested_at,
      workflow_timeout_ms: sql<
        number | null
      >`NULLIF(${workflowVersions.dag}->>'timeout_ms', '')::int`,
    })
    .from(executions)
    .leftJoin(workflowVersions, eq(workflowVersions.id, executions.workflow_version_id))
    .where(eq(executions.status, "running"))
    .limit(MAX_RECOVER_PER_PASS)) as CandidateRow[];

  let recovered = 0;
  for (const row of candidates) {
    const abortRequested = row.abort_requested_at !== null;
    if (!abortRequested && !row.started_at) continue; // can't classify an expiry without a start time
    const baseTimeout = row.workflow_timeout_ms ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
    const thresholdMs = opts.overrideThresholdMs ?? baseTimeout * CRASH_GRACE_MULTIPLIER;
    const ageMs = row.started_at ? now.getTime() - row.started_at.getTime() : null;
    if (!abortRequested && (ageMs === null || ageMs < thresholdMs)) continue;
    const terminalStatus = abortRequested ? "aborted" : "timed_out";
    const recoveryReason = abortRequested
      ? "engine_crash_recovery_abort_requested"
      : "engine_crash_recovery";

    try {
      const flipped = await db.transaction(async (tx) => {
        const updated = await tx
          .update(executions)
          .set({
            status: terminalStatus,
            finished_at: now,
            // The run's own failure record, as the engine's finalize writes
            // it. A crash between steps leaves no step row to carry a cause;
            // without this the run reads failed-without-a-cause forever.
            failure: {
              step_id: null,
              error_code: recoveryReason,
              error_message: abortRequested
                ? "execution abort recovered after worker restart"
                : "execution timeout recovered after worker restart",
            },
            output_contract: "none",
          })
          // status='running' is repeated in the WHERE so a competing
          // engine instance that already promoted this row loses the
          // race cleanly (the UPDATE returns no rows and we skip).
          .where(sql`${executions.id} = ${row.id} AND ${executions.status} = 'running'`)
          .returning({ id: executions.id });
        if (updated.length === 0) return false;

        const terminalizedSteps = await tx
          .update(executionSteps)
          .set({
            status: terminalStatus,
            finished_at: now,
            duration_ms: sql<number>`CASE
              WHEN ${executionSteps.started_at} IS NULL THEN NULL
              ELSE LEAST(
                2147483647,
                GREATEST(
                  0,
                  FLOOR(EXTRACT(EPOCH FROM (${now} - ${executionSteps.started_at})) * 1000)
                )
              )::int
            END`,
            error: {
              code: terminalStatus,
              message: abortRequested
                ? "execution abort recovered after worker restart"
                : "execution timeout recovered after worker restart",
            },
          })
          .where(
            sql`${executionSteps.execution_id} = ${row.id} AND ${executionSteps.status} = 'running'`,
          )
          .returning({
            step_key: executionSteps.step_key,
            step_index: executionSteps.step_index,
            kind: executionSteps.kind,
            duration_ms: executionSteps.duration_ms,
          });

        for (const step of terminalizedSteps) {
          await writeEvent(tx, {
            tenant_id: row.tenant_id,
            channel: "execution.status",
            type: "execution.step.finished",
            payload: {
              execution_id: row.id,
              step_key: step.step_key,
              step_index: step.step_index,
              kind: step.kind,
              status: terminalStatus,
              duration_ms: step.duration_ms,
              error_code: terminalStatus,
              reason: recoveryReason,
            },
          });
        }
        await writeEvent(tx, {
          tenant_id: row.tenant_id,
          channel: "execution.status",
          type: `execution.${terminalStatus}`,
          payload: {
            execution_id: row.id,
            status: terminalStatus,
            reason: recoveryReason,
          },
        });
        await recordExecutionCrashRecovered({
          tenant_id: row.tenant_id,
          actor_id: null,
          actor_type: "system",
          execution_id: row.id,
          workflow_id: row.workflow_id,
          reason: recoveryReason,
          metadata: {
            actor_type: "system",
            started_at: row.started_at?.toISOString() ?? null,
            abort_requested_at: row.abort_requested_at?.toISOString() ?? null,
            recovered_at: now.toISOString(),
            recovered_status: terminalStatus,
            timeout_ms: thresholdMs,
            workflow_timeout_ms: row.workflow_timeout_ms,
            age_ms: ageMs,
            source,
          },
          executor: tx,
        });
        return true;
      });
      if (!flipped) continue;

      recovered += 1;
      logger.info({
        module: "execution",
        action: "crash_recovery.row",
        msg: `execution forced to ${terminalStatus} by crash recovery sweep`,
        execution_id: row.id,
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        started_at: row.started_at?.toISOString() ?? null,
        abort_requested_at: row.abort_requested_at?.toISOString() ?? null,
        recovered_status: terminalStatus,
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

  // A previous engine version could terminalize the execution row while
  // leaving one or more step rows in `running`. Those rows no longer have a
  // running parent, so selecting only running executions can never repair
  // them. Reconcile that invariant independently on every pass. The initial
  // query is bounded by step rows, then de-duplicated by execution because a
  // single transaction repairs every still-running step of that parent.
  // tenant-filter:exempt — recovery sweeps every tenant on resume
  const inconsistentRows = (await db
    .select({
      id: executions.id,
      tenant_id: executions.tenant_id,
      workflow_id: executions.workflow_id,
      started_at: executions.started_at,
      finished_at: executions.finished_at,
      status: executions.status,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(
      sql`${executionSteps.status} = 'running'
        AND ${executions.status} IN ('succeeded', 'failed', 'aborted', 'timed_out')`,
    )
    .limit(MAX_RECOVER_PER_PASS)) as TerminalExecutionWithRunningStepRow[];

  const inconsistentExecutions = new Map(inconsistentRows.map((row) => [row.id, row] as const));
  let reconciledSteps = 0;
  for (const row of inconsistentExecutions.values()) {
    try {
      const terminalizedSteps = await db.transaction(async (tx) => {
        const stepFinishedAt = row.finished_at ?? now;
        const steps = await tx
          .update(executionSteps)
          .set({
            status: row.status,
            finished_at: stepFinishedAt,
            duration_ms: sql<number>`CASE
              WHEN ${executionSteps.started_at} IS NULL THEN NULL
              ELSE LEAST(
                2147483647,
                GREATEST(
                  0,
                  FLOOR(EXTRACT(EPOCH FROM (${stepFinishedAt} - ${executionSteps.started_at})) * 1000)
                )
              )::int
            END`,
            error:
              row.status === "succeeded"
                ? null
                : {
                    code: row.status,
                    message: `step state reconciled from terminal ${row.status} execution`,
                  },
          })
          .where(
            sql`${executionSteps.execution_id} = ${row.id} AND ${executionSteps.status} = 'running'`,
          )
          .returning({
            step_key: executionSteps.step_key,
            step_index: executionSteps.step_index,
            kind: executionSteps.kind,
            duration_ms: executionSteps.duration_ms,
          });

        for (const step of steps) {
          await writeEvent(tx, {
            tenant_id: row.tenant_id,
            channel: "execution.status",
            type: "execution.step.finished",
            payload: {
              execution_id: row.id,
              step_key: step.step_key,
              step_index: step.step_index,
              kind: step.kind,
              status: row.status,
              duration_ms: step.duration_ms,
              ...(row.status === "succeeded" ? {} : { error_code: row.status }),
              reason: "execution_step_state_reconciliation",
            },
          });
        }
        if (steps.length > 0) {
          await recordExecutionCrashRecovered({
            tenant_id: row.tenant_id,
            actor_id: null,
            actor_type: "system",
            execution_id: row.id,
            workflow_id: row.workflow_id,
            reason: "execution_step_state_reconciliation",
            metadata: {
              actor_type: "system",
              started_at: row.started_at?.toISOString() ?? null,
              finished_at: row.finished_at?.toISOString() ?? null,
              recovered_at: now.toISOString(),
              recovered_status: row.status,
              reconciled_step_count: steps.length,
              source,
            },
            executor: tx,
          });
        }
        return steps;
      });
      if (terminalizedSteps.length === 0) continue;

      reconciledSteps += terminalizedSteps.length;
      logger.info({
        module: "execution",
        action: "crash_recovery.steps_reconciled",
        msg: "running step rows reconciled from terminal execution state",
        execution_id: row.id,
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        recovered_status: row.status,
        reconciled_steps: terminalizedSteps.length,
      });
    } catch (err) {
      logger.error({
        module: "execution",
        action: "crash_recovery.steps_reconcile_failed",
        msg: "step-state reconciliation failed for one terminal execution",
        execution_id: row.id,
        tenant_id: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { recovered, reconciled_steps: reconciledSteps };
}

export interface CrashRecoveryMonitor {
  stop(): void;
  checkNow(): Promise<RecoverCrashedExecutionsResult>;
}

/**
 * Periodically reconcile executions whose owning worker disappeared.
 *
 * A boot-only sweep has a race: when an execution is younger than its grace
 * window during startup, it remains `running` forever because no later pass
 * revisits it. The recursive timer reads the setting after every pass, so an
 * operator can tune the cadence through SubKit settings without a deployment.
 * A single-flight guard prevents overlapping global scans on a slow database;
 * the row-level compare-and-set in recoverCrashedExecutions keeps concurrent
 * engine replicas safe.
 */
export function startCrashRecoveryMonitor(
  db: Db,
  options: {
    intervalMs?: () => number;
    recover?: () => Promise<RecoverCrashedExecutionsResult>;
  } = {},
): CrashRecoveryMonitor {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeCheck: Promise<RecoverCrashedExecutionsResult> | null = null;

  const intervalMs =
    options.intervalMs ?? (() => getConfig().queue.crash_recovery_sweep_interval_ms);
  const recover =
    options.recover ??
    (() => {
      const overrideThresholdMs = getConfig().queue.crash_recovery_threshold_ms;
      return recoverCrashedExecutions(db, {
        source: "periodic_recovery",
        ...(overrideThresholdMs > 0 ? { overrideThresholdMs } : {}),
      });
    });

  const checkNow = async (): Promise<RecoverCrashedExecutionsResult> => {
    if (activeCheck) return activeCheck;
    activeCheck = recover();
    try {
      return await activeCheck;
    } finally {
      activeCheck = null;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void checkNow()
        .then(({ recovered, reconciled_steps }) => {
          if (recovered > 0 || reconciled_steps > 0) {
            logger.info({
              module: "queue",
              action: "crash_recovery.periodic_complete",
              msg: "periodic crash recovery sweep finished",
              recovered,
              reconciled_steps,
            });
          }
        })
        .catch((err) => {
          logger.error({
            module: "queue",
            action: "crash_recovery.periodic_failed",
            msg: "periodic crash recovery sweep failed",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(schedule);
    }, intervalMs());
    if (typeof timer.unref === "function") timer.unref();
  };

  schedule();
  return {
    checkNow,
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
