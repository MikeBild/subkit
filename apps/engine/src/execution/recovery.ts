import { and, eq, inArray, sql } from "drizzle-orm";
import { recordExecutionCrashRecovered } from "../audit/recorders/index.ts";
import { getConfig } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import {
  deviceCommands,
  executionSteps,
  executions,
  workflowVersions,
} from "../db/schema/index.ts";
import { closeCommandsOfExecution } from "../devices/channel.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  crashRecoveryOutcome,
  interruptedWriteNotice,
  TERMINAL_EXECUTION_STATUSES,
  type TerminalExecutionStatus,
} from "./core/status.ts";
import { terminalizeExecutionRow } from "./state.ts";
import { classifyRequestStepSideEffects } from "./steps/request/side-effects.ts";

const DEFAULT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEVICE_STEP_INTERRUPTED = "device_step_interrupted";
const DEVICE_STEP_INTERRUPTED_MESSAGE =
  "The engine stopped while a step ran on a device. It is not run again; check on the device what was done.";
const CRASH_GRACE_MULTIPLIER = 1.5;
const MAX_RECOVER_PER_PASS = 1000;

interface RecoverCrashedExecutionsOptions {
  now?: Date;
  source?: "boot_recovery" | "periodic_recovery";
  overrideThresholdMs?: number;
}

interface RecoverCrashedExecutionsResult {
  recovered: number;
  reconciled_steps: number;
}

async function hasDeviceCommands(
  db: Db,
  tenant_id: string,
  execution_id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .where(
      and(eq(deviceCommands.tenant_id, tenant_id), eq(deviceCommands.execution_id, execution_id)),
    )
    .limit(1);
  return Boolean(row);
}

type RequestStep = Parameters<typeof classifyRequestStepSideEffects>[0];

function stepWrites(dag: unknown, step_key: string): boolean {
  const steps = (dag as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return false;
  const def = steps.find(
    (step): step is RequestStep =>
      typeof step === "object" && step !== null && (step as { id?: unknown }).id === step_key,
  );
  if (def?.kind !== "request") return false;
  try {
    return classifyRequestStepSideEffects(def) === "write";
  } catch {
    return true;
  }
}

async function runningWriteSteps(
  db: Db,
  tenant_id: string,
  execution_id: string,
  workflow_version_id: string | null,
): Promise<string[]> {
  const running = await db
    .select({ step_key: executionSteps.step_key })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.status, "running"),
        eq(executionSteps.kind, "request"),
      ),
    );
  if (running.length === 0 || workflow_version_id === null) return [];
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.id, workflow_version_id)),
    )
    .limit(1);
  return running.map((step) => step.step_key).filter((key) => stepWrites(version?.dag, key));
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
  workflow_version_id: string | null;
  started_at: Date | null;
  abort_requested_at: Date | null;
  workflow_timeout_ms: number | null;
}

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
      workflow_version_id: executions.workflow_version_id,
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
    const outcome = crashRecoveryOutcome(
      {
        abort_requested: row.abort_requested_at !== null,
        started_at_ms: row.started_at ? row.started_at.getTime() : null,
        workflow_timeout_ms: row.workflow_timeout_ms,
      },
      {
        now_ms: now.getTime(),
        default_timeout_ms: DEFAULT_WORKFLOW_TIMEOUT_MS,
        grace_multiplier: CRASH_GRACE_MULTIPLIER,
        override_threshold_ms: opts.overrideThresholdMs,
      },
    );
    if (!outcome) continue;
    const interrupted =
      outcome.status === "timed_out" && (await hasDeviceCommands(db, row.tenant_id, row.id));
    const writes = interrupted
      ? []
      : await runningWriteSteps(db, row.tenant_id, row.id, row.workflow_version_id);
    const writeNotice = interruptedWriteNotice(writes);
    const terminalStatus: TerminalExecutionStatus =
      interrupted || writeNotice ? "failed" : outcome.status;
    const recoveryReason: string = interrupted
      ? DEVICE_STEP_INTERRUPTED
      : (writeNotice?.code ?? outcome.reason);
    const recoveryMessage = interrupted
      ? DEVICE_STEP_INTERRUPTED_MESSAGE
      : (writeNotice?.message ?? outcome.message);
    const thresholdMs = outcome.threshold_ms;
    const ageMs = outcome.age_ms;

    try {
      const flipped = await db.transaction(async (tx) => {
        const updated = await terminalizeExecutionRow(tx, {
          tenant_id: row.tenant_id,
          execution_id: row.id,
          status: terminalStatus,
          finished_at: now,
          failure: {
            step_id: writeNotice?.step_id ?? null,
            error_code: recoveryReason,
            error_message: recoveryMessage,
          },
          expected_statuses: ["running"],
          output_contract: "none",
        });
        if (!updated) return false;
        if (interrupted) await closeCommandsOfExecution(tx, row.tenant_id, row.id, "lost");

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
              code: interrupted ? DEVICE_STEP_INTERRUPTED : terminalStatus,
              message: recoveryMessage,
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
        if (writeNotice) {
          await tx
            .update(executionSteps)
            .set({
              error: {
                code: writeNotice.code,
                message: writeNotice.message,
                guidance: writeNotice.guidance,
              },
            })
            .where(
              and(
                eq(executionSteps.execution_id, row.id),
                inArray(executionSteps.step_key, writes),
              ),
            );
        }

        for (const step of terminalizedSteps) {
          const wrote = writes.includes(step.step_key);
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
              error_code: wrote && writeNotice ? writeNotice.code : terminalStatus,
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
            interrupted_writes: writes,
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
      and(
        eq(executionSteps.status, "running"),
        inArray(executions.status, [...TERMINAL_EXECUTION_STATUSES]),
      ),
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

interface CrashRecoveryMonitor {
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
