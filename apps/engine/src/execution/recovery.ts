import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { AuditAction, auditAwait, recordExecutionCrashRecovered } from "../audit/index.ts";
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
import { executableDefinition, type StepDef } from "../workflows/index.ts";
import {
  assembleFixtures,
  ENGINE_STOPPED,
  ENGINE_STOPPED_MESSAGE,
  interruptedWriteKeys,
  type ResumeDecision,
  type ResumeFacts,
  type ResumeRow,
  type ResumeStep,
  resumeDecision,
  storedStepOutput,
} from "./core/resume.ts";
import {
  crashRecoveryOutcome,
  type ExecutionStatus,
  interruptedWriteNotice,
  type StepStatus,
  TERMINAL_EXECUTION_STATUSES,
  type TerminalExecutionStatus,
} from "./core/status.ts";
import { wrapEnvelope } from "./engine/envelope.ts";
import { resolveOffloaded } from "./offload.ts";
import { isSensitivePayload } from "./sensitive-payload.ts";
import { claimStaleRunning, markExecutionUncertain, terminalizeExecutionRow } from "./state.ts";
import { RUN_HEARTBEAT_LEASE_MS } from "./timeouts.ts";

const DEFAULT_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEVICE_STEP_INTERRUPTED = "device_step_interrupted";
const DEVICE_STEP_INTERRUPTED_MESSAGE =
  "The engine stopped while a step ran on a device. It is not run again; check on the device what was done.";
const CRASH_GRACE_MULTIPLIER = 1.5;
const MAX_RECOVER_PER_PASS = 1000;

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

function hasSecretOutputs(step: StepDef): boolean {
  if (step.kind !== "request") return false;
  const outputs = (step as { outputs?: Record<string, { secret?: boolean } | undefined> }).outputs;
  return Object.values(outputs ?? {}).some((output) => output?.secret === true);
}

function resumeSteps(dag: unknown): ResumeStep[] {
  let steps: readonly StepDef[];
  try {
    steps = executableDefinition(dag).steps;
  } catch {
    return [];
  }
  return steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    for_each: Boolean(step.for_each),
    secret_outputs: hasSecretOutputs(step),
  }));
}

type StepRow = typeof executionSteps.$inferSelect;

async function loadStepRows(db: Db, tenant_id: string, execution_id: string): Promise<StepRow[]> {
  return db
    .select()
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, tenant_id), eq(executionSteps.execution_id, execution_id)),
    )
    .orderBy(asc(executionSteps.started_at));
}

function resumeRows(rows: readonly StepRow[]): ResumeRow[] {
  return rows.map((row) => ({
    step_key: row.step_key,
    status: row.status as StepStatus,
    write_dispatched: row.write_dispatched_at !== null,
  }));
}

async function loadResumeSteps(
  db: Db,
  tenant_id: string,
  workflow_version_id: string | null,
): Promise<ResumeStep[]> {
  if (!workflow_version_id) return [];
  const [version] = await db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenant_id), eq(workflowVersions.id, workflow_version_id)),
    )
    .limit(1);
  return version ? resumeSteps(version.dag) : [];
}

async function loadResumeRows(
  db: Db,
  tenant_id: string,
  execution_id: string,
): Promise<ResumeRow[]> {
  return resumeRows(await loadStepRows(db, tenant_id, execution_id));
}

interface CrashSettlement {
  tenant_id: string;
  execution_id: string;
  workflow_id: string | null;
  status: "uncertain" | TerminalExecutionStatus;
  reason: string;
  message: string;
  write_keys: readonly string[];
  device_interrupted: boolean;
  now: Date;
  expected_statuses: readonly ExecutionStatus[];
  source: string;
  audit: Record<string, unknown>;
}

async function settleCrashedExecution(db: Db, s: CrashSettlement): Promise<boolean> {
  const notice = s.device_interrupted ? null : interruptedWriteNotice(s.write_keys);
  const failure = {
    step_id: notice?.step_id ?? null,
    error_code: s.reason,
    error_message: s.message,
  };
  const writeKeys = [...s.write_keys];
  return db.transaction(async (tx) => {
    if (s.status === "uncertain") {
      if (!notice) return false;
      const marked = await markExecutionUncertain(tx, {
        tenant_id: s.tenant_id,
        execution_id: s.execution_id,
        failure,
      });
      if (!marked) return false;
      await tx
        .update(executionSteps)
        .set({
          status: "uncertain",
          error: { code: notice.code, message: notice.message, guidance: notice.guidance },
        })
        .where(
          and(
            eq(executionSteps.tenant_id, s.tenant_id),
            eq(executionSteps.execution_id, s.execution_id),
            eq(executionSteps.status, "running"),
            inArray(executionSteps.step_key, writeKeys),
          ),
        );
      await writeEvent(tx, {
        tenant_id: s.tenant_id,
        channel: "execution.status",
        type: "execution.uncertain",
        payload: {
          execution_id: s.execution_id,
          status: "uncertain",
          reason: s.reason,
          step_keys: writeKeys,
        },
      });
      await auditAwait(
        {
          tenant_id: s.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.EXECUTION_WRITE_UNCERTAIN,
          resource_type: "execution",
          resource_id: s.execution_id,
          result: "success",
          reason: s.reason,
          metadata: {
            ...s.audit,
            ...(s.workflow_id ? { workflow_id: s.workflow_id } : {}),
            step_keys: writeKeys,
            source: s.source,
          },
        },
        tx,
      );
      return true;
    }

    const status = s.status;
    const updated = await terminalizeExecutionRow(tx, {
      tenant_id: s.tenant_id,
      execution_id: s.execution_id,
      status,
      finished_at: s.now,
      failure,
      expected_statuses: s.expected_statuses,
      output_contract: "none",
    });
    if (!updated) return false;
    if (s.device_interrupted)
      await closeCommandsOfExecution(tx, s.tenant_id, s.execution_id, "lost");

    const terminalizedSteps = await tx
      .update(executionSteps)
      .set({
        status,
        finished_at: s.now,
        duration_ms: sql<number>`CASE
          WHEN ${executionSteps.started_at} IS NULL THEN NULL
          ELSE LEAST(
            2147483647,
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (${s.now} - ${executionSteps.started_at})) * 1000)
            )
          )::int
        END`,
        error: { code: s.device_interrupted ? s.reason : status, message: s.message },
      })
      .where(
        and(
          eq(executionSteps.tenant_id, s.tenant_id),
          eq(executionSteps.execution_id, s.execution_id),
          eq(executionSteps.status, "running"),
        ),
      )
      .returning({
        id: executionSteps.id,
        step_key: executionSteps.step_key,
        step_index: executionSteps.step_index,
        kind: executionSteps.kind,
        duration_ms: executionSteps.duration_ms,
      });
    const wroteIds = terminalizedSteps
      .filter((step) => writeKeys.includes(step.step_key))
      .map((step) => step.id);
    if (notice && wroteIds.length > 0) {
      await tx
        .update(executionSteps)
        .set({
          error: { code: notice.code, message: notice.message, guidance: notice.guidance },
        })
        .where(
          and(eq(executionSteps.tenant_id, s.tenant_id), inArray(executionSteps.id, wroteIds)),
        );
    }
    for (const step of terminalizedSteps) {
      await writeEvent(tx, {
        tenant_id: s.tenant_id,
        channel: "execution.status",
        type: "execution.step.finished",
        payload: {
          execution_id: s.execution_id,
          step_key: step.step_key,
          step_index: step.step_index,
          kind: step.kind,
          status,
          duration_ms: step.duration_ms,
          error_code: notice && wroteIds.includes(step.id) ? notice.code : status,
          reason: s.reason,
        },
      });
    }
    await writeEvent(tx, {
      tenant_id: s.tenant_id,
      channel: "execution.status",
      type: `execution.${status}`,
      payload: { execution_id: s.execution_id, status, reason: s.reason },
    });
    await recordExecutionCrashRecovered({
      tenant_id: s.tenant_id,
      actor_id: null,
      actor_type: "system",
      execution_id: s.execution_id,
      workflow_id: s.workflow_id,
      reason: s.reason,
      metadata: {
        actor_type: "system",
        recovered_at: s.now.toISOString(),
        recovered_status: status,
        interrupted_writes: writeKeys,
        source: s.source,
        ...s.audit,
      },
      executor: tx,
    });
    return true;
  });
}

async function rowEnvelope(db: Db, tenant_id: string, row: StepRow): Promise<unknown> {
  const data = row.result_storage_uri
    ? await resolveOffloaded(db, tenant_id, {
        $offloaded: true,
        storage_uri: row.result_storage_uri,
        preview: row.result_preview ?? "",
        size_bytes: 0,
      })
    : storedStepOutput(row.output_preview);
  return wrapEnvelope({
    data,
    duration_ms: row.duration_ms ?? 0,
    error: null,
    request_meta: (row.request_meta as Record<string, unknown> | null) ?? null,
  });
}

async function rebuildFixtures(
  db: Db,
  tenant_id: string,
  rows: readonly StepRow[],
  decision: Extract<ResumeDecision, { kind: "resume" }>,
): Promise<Record<string, unknown>> {
  const wanted = new Set(decision.fixtures);
  const envelopes: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.status !== "succeeded" || !wanted.has(row.step_key)) continue;
    envelopes[row.step_key] = await rowEnvelope(db, tenant_id, row);
  }
  return assembleFixtures(envelopes, decision.completed_for_each);
}

async function supersedeRows(
  db: Db,
  tenant_id: string,
  execution_id: string,
  step_keys: readonly string[],
  now: Date,
): Promise<void> {
  if (step_keys.length === 0) return;
  await db
    .update(executionSteps)
    .set({
      status: "skipped",
      finished_at: now,
      error: {
        code: ENGINE_STOPPED,
        message: "The engine stopped during this step. It runs again.",
      },
    })
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.status, "running"),
        inArray(executionSteps.step_key, [...step_keys]),
      ),
    );
}

export type ResumePlan =
  | { kind: "skip"; reason: string }
  | { kind: "start" }
  | { kind: "run"; crash_resume: Record<string, unknown>; claimed: boolean }
  | { kind: "settled"; status: "uncertain" | "failed" };

interface PlanResumeParams {
  tenant_id: string;
  execution_id: string;
  now?: Date;
  lease_ms?: number;
  source?: string;
}

export async function planResume(db: Db, p: PlanResumeParams): Promise<ResumePlan> {
  const now = p.now ?? new Date();
  const lease_ms = p.lease_ms ?? RUN_HEARTBEAT_LEASE_MS;
  const source = p.source ?? "queue_redelivery";
  const { tenant_id, execution_id } = p;
  const [row] = await db
    .select({
      status: executions.status,
      attempt: executions.attempt,
      heartbeat_at: executions.heartbeat_at,
      budget_park: executions.budget_park,
      hold_writes: executions.hold_writes,
      tool_approval_id: executions.tool_approval_id,
      parent_execution_id: executions.parent_execution_id,
      execution_authority_id: executions.execution_authority_id,
      input: executions.input,
      workflow_id: executions.workflow_id,
      workflow_version_id: executions.workflow_version_id,
    })
    .from(executions)
    .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, execution_id)))
    .limit(1);
  if (!row) return { kind: "start" };
  const running = row.status === "running";
  const resolved = row.status === "queued" && row.attempt > 0 && row.budget_park === null;
  if (!running && !resolved) return { kind: "start" };

  const rows = await loadStepRows(db, tenant_id, execution_id);
  const facts: ResumeFacts = {
    status: row.status,
    heartbeat_age_ms: row.heartbeat_at ? now.getTime() - row.heartbeat_at.getTime() : null,
    lease_ms,
    sensitive: isSensitivePayload(row.input),
    held: row.hold_writes || row.tool_approval_id !== null,
    child: row.parent_execution_id !== null,
    unsaved: row.workflow_id === null || row.workflow_version_id === null,
    direct: row.execution_authority_id === null,
    device: await hasDeviceCommands(db, tenant_id, execution_id),
    steps: await loadResumeSteps(db, tenant_id, row.workflow_version_id),
    rows: resumeRows(rows),
  };
  const decision = resumeDecision(facts);
  if (decision.kind === "alive") return { kind: "skip", reason: "alive" };
  if (decision.kind === "fresh" && !running) return { kind: "start" };
  if (running) {
    const attempt = await claimStaleRunning(db, tenant_id, execution_id, lease_ms, now);
    if (attempt === null) return { kind: "skip", reason: "claimed_elsewhere" };
  }
  logger.info({
    module: "execution",
    action: "crash_resume.decision",
    msg: `stale run decided as ${decision.kind}`,
    tenant_id,
    execution_id,
    decision: decision.kind,
    ...(decision.kind === "not_resumable" ? { reason: decision.reason } : {}),
  });
  if (decision.kind === "fresh") return { kind: "run", crash_resume: {}, claimed: true };
  if (decision.kind === "resume") {
    const crash_resume = await rebuildFixtures(db, tenant_id, rows, decision);
    await supersedeRows(db, tenant_id, execution_id, decision.superseded, now);
    return { kind: "run", crash_resume, claimed: running };
  }
  const settlement = {
    tenant_id,
    execution_id,
    workflow_id: row.workflow_id,
    device_interrupted: false,
    now,
    expected_statuses: ["running", "queued"] as const,
    source,
  };
  if (decision.kind === "uncertain") {
    const notice = interruptedWriteNotice(decision.step_keys);
    const settled = await settleCrashedExecution(db, {
      ...settlement,
      status: "uncertain",
      reason: notice?.code ?? ENGINE_STOPPED,
      message: notice?.message ?? ENGINE_STOPPED_MESSAGE,
      write_keys: decision.step_keys,
      audit: {},
    });
    return settled ? { kind: "settled", status: "uncertain" } : { kind: "skip", reason: "settled" };
  }
  const notice = interruptedWriteNotice(decision.interrupted_writes);
  const settled = await settleCrashedExecution(db, {
    ...settlement,
    status: "failed",
    reason: notice?.code ?? ENGINE_STOPPED,
    message: notice?.message ?? ENGINE_STOPPED_MESSAGE,
    write_keys: decision.interrupted_writes,
    audit: { not_resumable: decision.reason },
  });
  return settled ? { kind: "settled", status: "failed" } : { kind: "skip", reason: "settled" };
}

interface RecoverCrashedExecutionsOptions {
  now?: Date;
  source?: "boot_recovery" | "periodic_recovery";
  overrideThresholdMs?: number;
  leaseMs?: number;
  enqueue?: StaleRunEnqueue;
}

export interface StaleRunJob {
  tenant_id: string;
  workflow_id: string;
  execution_id: string;
}

export type StaleRunEnqueue = (job: StaleRunJob) => Promise<void>;

interface RecoverCrashedExecutionsResult {
  recovered: number;
  reconciled_steps: number;
  requeued: number;
}

async function recoverStaleRun(
  db: Db,
  row: CandidateRow,
  now: Date,
  source: string,
  opts: RecoverCrashedExecutionsOptions,
): Promise<{ requeued: number; recovered: number }> {
  try {
    if (row.workflow_id) {
      if (!opts.enqueue) return { requeued: 0, recovered: 0 };
      await opts.enqueue({
        tenant_id: row.tenant_id,
        workflow_id: row.workflow_id,
        execution_id: row.id,
      });
      return { requeued: 1, recovered: 0 };
    }
    const plan = await planResume(db, {
      tenant_id: row.tenant_id,
      execution_id: row.id,
      now,
      source,
      ...(opts.leaseMs !== undefined ? { lease_ms: opts.leaseMs } : {}),
    });
    return { requeued: 0, recovered: plan.kind === "settled" ? 1 : 0 };
  } catch (err) {
    logger.warn({
      module: "execution",
      action: "crash_recovery.stale_run_failed",
      msg: "a run without a recent heartbeat could not be handed to recovery",
      execution_id: row.id,
      tenant_id: row.tenant_id,
      ...errorFields(err),
    });
    return { requeued: 0, recovered: 0 };
  }
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
  heartbeat_at: Date | null;
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
      heartbeat_at: executions.heartbeat_at,
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
  let requeued = 0;
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
    if (!outcome) {
      if (
        row.heartbeat_at !== null &&
        now.getTime() - row.heartbeat_at.getTime() >= (opts.leaseMs ?? RUN_HEARTBEAT_LEASE_MS)
      ) {
        const stale = await recoverStaleRun(db, row, now, source, opts);
        requeued += stale.requeued;
        recovered += stale.recovered;
      }
      continue;
    }
    const interrupted =
      outcome.status === "timed_out" && (await hasDeviceCommands(db, row.tenant_id, row.id));
    const writes = interrupted
      ? []
      : interruptedWriteKeys(await loadResumeRows(db, row.tenant_id, row.id));
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
      const flipped = await settleCrashedExecution(db, {
        tenant_id: row.tenant_id,
        execution_id: row.id,
        workflow_id: row.workflow_id,
        status: terminalStatus,
        reason: recoveryReason,
        message: recoveryMessage,
        write_keys: writes,
        device_interrupted: interrupted,
        now,
        expected_statuses: ["running"],
        source,
        audit: {
          started_at: row.started_at?.toISOString() ?? null,
          abort_requested_at: row.abort_requested_at?.toISOString() ?? null,
          timeout_ms: thresholdMs,
          workflow_timeout_ms: row.workflow_timeout_ms,
          age_ms: ageMs,
        },
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

  return { recovered, reconciled_steps: reconciledSteps, requeued };
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
    enqueue?: StaleRunEnqueue;
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
        ...(options.enqueue ? { enqueue: options.enqueue } : {}),
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
