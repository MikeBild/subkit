// Worker for the `execution.run` queue.
//
// The job payload is a small envelope that points at an existing
// executions row admitted before enqueue. Legacy jobs without a bound live
// authority or an explicit persisted preparation cannot acquire authority
// merely by being dequeued after an upgrade.

import { and, asc, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { auditAdmissionRefusal } from "../../execution/admission-audit.ts";
import { runExecution } from "../../execution/engine.ts";
import { finalizeExecution } from "../../execution/state.ts";
import type { RequestSource, RunOptions } from "../../execution/types.ts";
import { log, logger } from "../../logging/logger.ts";
import {
  endpointKeyFromRequestMeta,
  parsePersistedRequestMeta,
} from "../../self-healing/step-snapshot.ts";
import { withJobContext } from "../job-context.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";
import { enqueueRepair } from "./workflow-repair.ts";

export interface RegisterExecutionRunOptions {
  boss: PgBoss;
  db: Db;
}

/**
 * Reactive self-healing producer. A failed run whose first failed
 * REQUEST step carries a connector anchor becomes a `workflow.repair`
 * job — the only path that can catch vendor-side contract drift the
 * proactive scanner is blind to (a failing endpoint records no new
 * shape to diff). Flood control is layered: `enqueueRepair` collapses
 * repeats per (tenant, workflow, endpoint) under a pg-boss singleton
 * window, and `processDriftSignal` dedups against active/terminal
 * candidates by drift fingerprint. Best-effort: a repair enqueue
 * failure must never fail the execution job itself.
 */
async function maybeEnqueueRepair(
  boss: PgBoss,
  db: Db,
  p: { tenant_id: string; workflow_id: string; execution_id: string },
): Promise<void> {
  try {
    const [execution] = await db
      .select({ held: executions.hold_writes, authority: executions.execution_authority_id })
      .from(executions)
      .where(and(eq(executions.tenant_id, p.tenant_id), eq(executions.id, p.execution_id)))
      .limit(1);
    // A preparation or bound live run cannot silently authorize a repair job
    // after the engine correctly disabled its own self-healing option.
    if (execution?.held || execution?.authority) return;
    const rows = await db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, p.tenant_id),
          eq(executionSteps.execution_id, p.execution_id),
          eq(executionSteps.status, "failed"),
          eq(executionSteps.kind, "request"),
        ),
      )
      .orderBy(asc(executionSteps.step_index))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    const meta = parsePersistedRequestMeta(row.request_meta);
    const connector_id =
      meta && "connector" in meta && meta.connector ? meta.connector.connector_id : null;
    if (!connector_id) return; // connectorless failures carry no repair anchor
    const endpoint_key = endpointKeyFromRequestMeta(meta);
    const jobId = await enqueueRepair(boss, {
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      execution_id: p.execution_id,
      step_id: row.id,
      connector_id,
      endpoint_key,
    });
    logger.info({
      module: "self-healing",
      action: jobId ? "repair.enqueued" : "repair.enqueue_deduped",
      msg: jobId
        ? "failed request step enqueued for reactive repair"
        : "reactive repair suppressed — singleton window already holds a job for this endpoint",
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      execution_id: p.execution_id,
      step_id: row.id,
      connector_id,
      endpoint_key,
    });
  } catch (err) {
    logger.warn({
      module: "self-healing",
      action: "repair.enqueue_failed",
      msg: "reactive repair enqueue failed — execution outcome unaffected",
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      execution_id: p.execution_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleOne(job: Job<ExecutionRunJob>, db: Db, boss: PgBoss): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "execution.run job dequeued",
    queue: EXECUTION_RUN_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    workflow_id: data.workflow_id,
    execution_id: data.execution_id ?? null,
  });
  const started = Date.now();
  const runOptions: RunOptions = {
    request_source: (data.request_source as RequestSource) ?? "api",
    parent_execution_id: data.parent_execution_id ?? null,
    trace_id: data.trace_id ?? null,
  };
  if (data.execution_id) runOptions.existing_execution_id = data.execution_id;
  if (data.execution_mode) runOptions.execution_mode = data.execution_mode;
  try {
    const [boundary] = data.execution_id
      ? await db
          .select({ held: executions.hold_writes, authority: executions.execution_authority_id })
          .from(executions)
          .where(
            and(
              eq(executions.tenant_id, data.tenant_id),
              eq(executions.workflow_id, data.workflow_id),
              eq(executions.id, data.execution_id),
            ),
          )
          .limit(1)
      : [];
    if (!boundary || (!boundary.held && !boundary.authority)) {
      const message =
        "queued execution has no admitted boundary; request a new preparation or an authorized run";
      // Actor-less on purpose: whoever enqueued the job is one hop away and
      // the job payload does not carry them. The execution id does, and it
      // leads back to the row that names the requester.
      await auditAdmissionRefusal(
        {
          tenant_id: data.tenant_id,
          reason: "execution_authority_required",
          message,
          workflow_id: data.workflow_id,
          execution_id: data.execution_id ?? null,
          request_source: (data.request_source as string) ?? "api",
          extra: { queue: EXECUTION_RUN_QUEUE },
        },
        db,
      );
      throw Object.assign(new Error(message), { code: "execution_authority_required" });
    }
    const result = await runExecution({
      db,
      tenant_id: data.tenant_id,
      source: { kind: "saved", workflow_id: data.workflow_id },
      input: data.input ?? null,
      options: runOptions,
    });
    log.queue.job.completed({
      msg: "execution.run job completed",
      queue: EXECUTION_RUN_QUEUE,
      job_id: job.id,
      execution_id: result.execution_id,
      status: result.status,
      duration_ms: Date.now() - started,
    });
    if (result.status === "failed") {
      await maybeEnqueueRepair(boss, db, {
        tenant_id: data.tenant_id,
        workflow_id: data.workflow_id,
        execution_id: result.execution_id,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "execution.run job failed",
      queue: EXECUTION_RUN_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    // runExecution only throws on EARLY errors (input-schema violation,
    // definition resolution, depth limit) — before the engine finalizes
    // the row itself. The row was pre-created `queued` by the HTTP enqueue,
    // so without this it would strand forever. Record the failure on the
    // row (CAS-guarded — a no-op if the engine already finalized it) so a
    // polling client sees a terminal state. Finalizing successfully means
    // the DB is reachable and the error was deterministic, so we do NOT
    // re-throw (a retry would just loop on the same bad input). If the
    // finalize itself fails (e.g. DB down), propagate so pg-boss retries.
    if (data.execution_id) {
      const code =
        typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : "execution_error";
      try {
        await finalizeExecution(db, data.tenant_id, data.execution_id, "failed", null, {
          step_id: null,
          error_code: code,
          error_message: message,
        });
        return;
      } catch {
        // fall through to re-throw the original error
      }
    }
    throw err;
  }
}

export async function registerExecutionRunHandler(
  opts: RegisterExecutionRunOptions,
): Promise<string> {
  const { boss, db } = opts;
  // One at a time by default: an execution can hold the slot for as long as
  // its longest step, and the safe default is the one that cannot surprise an
  // operator with parallel side effects. `queue.concurrency` raises it, and is
  // read here rather than per job because pg-boss fixes worker options at
  // registration — which is why the setting is restart-required.
  // Tolerates an uninitialised loader: worker registration happens in contexts
  // that never load configuration — the scheduler's own tests among them — and
  // a throw here would take down the queue rather than fall back to the value
  // this was hard-coded to before the setting was wired up.
  let concurrency = 1;
  try {
    concurrency = getConfig().queue.concurrency;
  } catch {
    concurrency = 1;
  }
  const workerId = await boss.work<ExecutionRunJob>(
    EXECUTION_RUN_QUEUE,
    { batchSize: concurrency, pollingIntervalSeconds: 1 },
    async (jobs: Job<ExecutionRunJob>[]) => {
      for (const job of jobs) {
        // Bridge the enqueuing trace_id/tenant across the queue boundary so
        // every downstream execution.* log inherits the originating context.
        await withJobContext(job.data, () => handleOne(job, db, boss));
      }
    },
  );
  log.queue.worker.registered({
    msg: "execution.run worker registered",
    worker_id: workerId,
  });
  return workerId;
}
