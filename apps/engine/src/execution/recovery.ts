import { eq, sql } from "drizzle-orm";
import { recordExecutionCrashRecovered } from "../audit/recorders/index.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { executionSteps, executions, workflowVersions } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import type { ExecutionStatus } from "./types.ts";

const DEFAULT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const CRASH_GRACE_MULTIPLIER = 1.5;
const MAX_RECOVER_PER_PASS = 1000;

export interface RecoverCrashedExecutionsOptions {
  now?: Date;
  source?: "boot_recovery" | "periodic_recovery";
  overrideThresholdMs?: number;
}

export interface RecoverCrashedExecutionsResult {
  recovered: number;
  reconciled_steps: number;
}

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

export async function recoverCrashedExecutions(
  db: Db,
  opts: RecoverCrashedExecutionsOptions = {},
): Promise<RecoverCrashedExecutionsResult> {
  const now = opts.now ?? new Date();
  const source = opts.source ?? "boot_recovery";

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
    if (!abortRequested && !row.started_at) continue;
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
            failure: {
              step_id: null,
              error_code: recoveryReason,
              error_message: abortRequested
                ? "execution abort recovered after worker restart"
                : "execution timeout recovered after worker restart",
            },
            output_contract: "none",
          })
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
      logger.error({
        module: "execution",
        action: "crash_recovery.row_failed",
        msg: "crash recovery failed for one execution",
        execution_id: row.id,
        tenant_id: row.tenant_id,
        ...errorFields(err),
      });
    }
  }

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
        ...errorFields(err),
      });
    }
  }

  return { recovered, reconciled_steps: reconciledSteps };
}

export interface CrashRecoveryMonitor {
  stop(): Promise<void>;
  checkNow(): Promise<RecoverCrashedExecutionsResult>;
}

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
    if (stopped) throw new Error("crash_recovery_monitor_stopped");
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
      if (stopped) return;
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
            ...errorFields(err),
          });
        })
        .finally(schedule);
    }, intervalMs());
    if (typeof timer.unref === "function") timer.unref();
  };

  schedule();
  return {
    checkNow,
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await activeCheck;
    },
  };
}
