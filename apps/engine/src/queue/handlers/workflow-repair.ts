import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import type { Db } from "../../db/client.ts";
import { workflows } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { readMemoryUsage } from "../../observability/runtime-telemetry.ts";
import { proposeGateRepairs } from "../../self-healing/gate-repairs.ts";
import { runSelfHealingLoop } from "../../self-healing/service.ts";
import type { WorkflowRepairJob } from "../../self-healing/types.ts";
import { withActiveTenantJobContext } from "../job-context.ts";

export const WORKFLOW_REPAIR_QUEUE = "workflow.repair" as const;

export interface RegisterWorkflowRepairOptions {
  boss: PgBoss;
  db: Db;
}

async function handleGateBlock(
  job: Job<WorkflowRepairJob>,
  db: Db,
  started: number,
): Promise<void> {
  const data = job.data;
  try {
    if (!data.version_id || !data.environment)
      throw new Error("a gate_block job carries version_id and environment");
    const outcomes = await proposeGateRepairs(db, {
      tenant_id: data.tenant_id,
      workflow_id: data.workflow_id,
      version_id: data.version_id,
      environment: data.environment,
    });
    log.queue.job.completed({
      msg: "workflow.repair gate job completed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      trigger: data.trigger,
      version_id: data.version_id,
      candidates_created: outcomes.filter((o) => o.created).length,
      candidates_existing: outcomes.filter((o) => !o.created).length,
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    log.queue.job.failed({
      msg: "workflow.repair gate job failed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      trigger: data.trigger,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

async function handleOne(job: Job<WorkflowRepairJob>, db: Db): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "workflow.repair job dequeued",
    queue: WORKFLOW_REPAIR_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    workflow_id: data.workflow_id,
    execution_id: data.execution_id,
    step_id: data.step_id,
  });
  const started = Date.now();
  if (data.trigger === "gate_block") return await handleGateBlock(job, db, started);
  const rssBefore = readMemoryUsage().rss;
  try {
    const result = await runSelfHealingLoop(data, db);
    log.queue.job.completed({
      msg: "workflow.repair job completed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      drift_detected: result.drift_detected,
      patch_candidate_id: result.patch_candidate_id,
      classification: result.classification,
      auto_applied: result.auto_applied,
      reason: result.reason,
      duration_ms: Date.now() - started,
      rss_mb: Math.round((readMemoryUsage().rss / 1048576) * 10) / 10,
      rss_delta_mb: Math.round(((readMemoryUsage().rss - rssBefore) / 1048576) * 10) / 10,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "workflow.repair job failed",
      queue: WORKFLOW_REPAIR_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
    throw err;
  }
}

export async function registerWorkflowRepairHandler(
  opts: RegisterWorkflowRepairOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<WorkflowRepairJob>(
    WORKFLOW_REPAIR_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<WorkflowRepairJob>[]) => {
      for (const job of jobs) {
        await withActiveTenantJobContext(job.data, db, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "workflow.repair worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export const REPAIR_SINGLETON_SECONDS = 3600;

export async function enqueueRepair(
  boss: PgBoss,
  payload: WorkflowRepairJob,
): Promise<string | null> {
  const singletonKey = `${payload.tenant_id}:${payload.workflow_id}:${payload.endpoint_key ?? payload.step_id ?? "unknown"}`;
  return await boss.send(WORKFLOW_REPAIR_QUEUE, payload, {
    singletonKey,
    singletonSeconds: REPAIR_SINGLETON_SECONDS,
  });
}

export async function enqueueGateDiagnosis(
  boss: PgBoss,
  db: Db,
  p: {
    tenant_id: string;
    workflow_id: string;
    environment: "dev" | "prod";
    version_id?: string | null;
    execution_id?: string | null;
    source: "inbound_hook" | "schedule" | "dispatch";
  },
): Promise<string | null> {
  try {
    let version_id = p.version_id ?? null;
    if (!version_id) {
      const [workflow] = await db
        .select({ version_id: workflows.current_version_id })
        .from(workflows)
        .where(and(eq(workflows.tenant_id, p.tenant_id), eq(workflows.id, p.workflow_id)))
        .limit(1);
      version_id = workflow?.version_id ?? null;
    }
    if (!version_id) return null;
    const payload: WorkflowRepairJob = {
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      execution_id: p.execution_id ?? null,
      step_id: null,
      trigger: "gate_block",
      version_id,
      environment: p.environment,
    };
    const jobId = await boss.send(WORKFLOW_REPAIR_QUEUE, payload, {
      singletonKey: `${p.tenant_id}:${p.workflow_id}:gate:${p.environment}:${version_id}`,
      singletonSeconds: REPAIR_SINGLETON_SECONDS,
    });
    logger.info({
      module: "self-healing",
      action: jobId ? "gate_diagnosis.enqueued" : "gate_diagnosis.enqueue_deduped",
      msg: jobId
        ? "gate refusal enqueued for diagnosis"
        : "gate diagnosis suppressed — singleton window already holds a job for this version and environment",
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      version_id,
      environment: p.environment,
      source: p.source,
    });
    return jobId;
  } catch (err) {
    logger.warn({
      module: "self-healing",
      action: "gate_diagnosis.enqueue_failed",
      msg: "gate diagnosis enqueue failed — the refusal stands as answered",
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      source: p.source,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
