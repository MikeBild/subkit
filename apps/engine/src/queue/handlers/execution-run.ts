import { and, asc, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { auditAdmissionRefusal } from "../../execution/admission-audit.ts";
import { rehydrateExecutionPrincipal } from "../../execution/authorization-context.ts";
import { CallerContextSchema } from "../../execution/caller-context.ts";
import {
  resolveExecutionCallerActor,
  resolveExecutionCallerOrigin,
} from "../../execution/caller-origin.ts";
import { runExecution } from "../../execution/engine.ts";
import {
  captureWorkflowPermission,
  recordStartingWorkflowPermission,
} from "../../execution/index.ts";
import { finalizeExecution, GOVERNANCE_REFUSALS } from "../../execution/state.ts";
import type { RequestSource, RunOptions } from "../../execution/types.ts";
import { withContext } from "../../logging/context.ts";
import { log, logger } from "../../logging/logger.ts";
import { RequestSourceSchema } from "../../observability/service-metadata.ts";
import { can } from "../../rbac/evaluator.ts";
import {
  endpointKeyFromRequestMeta,
  parsePersistedRequestMeta,
} from "../../self-healing/step-snapshot.ts";
import {
  finalizeHostedContentQuota,
  hostedContentQuotaCode,
} from "../hosted-content-finalization.ts";
import {
  HostedWorkQuotaError,
  hostedQueueGroupConcurrency,
  ifHostedJobStillPending,
  withHostedWork,
} from "../hosted-work.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";
import { enqueueGateDiagnosis, enqueueRepair } from "./workflow-repair.ts";

export interface RegisterExecutionRunOptions {
  boss: PgBoss;
  db: Db;
}

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
    if (!connector_id) return;
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

async function maybeEnqueueGateDiagnosis(
  boss: PgBoss,
  db: Db,
  p: { tenant_id: string; workflow_id: string; execution_id: string },
): Promise<void> {
  try {
    const [execution] = await db
      .select({
        authority: executions.execution_authority_id,
        version_id: executions.workflow_version_id,
        environment: executions.execution_mode,
        failure: executions.failure,
      })
      .from(executions)
      .where(and(eq(executions.tenant_id, p.tenant_id), eq(executions.id, p.execution_id)))
      .limit(1);
    if (!execution?.authority || !execution.version_id) return;
    const code = execution.failure?.error_code;
    if (!code || !GOVERNANCE_REFUSALS.has(code)) return;
    await enqueueGateDiagnosis(boss, db, {
      tenant_id: p.tenant_id,
      workflow_id: p.workflow_id,
      execution_id: p.execution_id,
      version_id: execution.version_id,
      environment: execution.environment,
      source: "dispatch",
    });
  } catch (err) {
    logger.warn({
      module: "self-healing",
      action: "gate_diagnosis.enqueue_failed",
      msg: "gate diagnosis enqueue failed — execution outcome unaffected",
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
          .select({
            held: executions.hold_writes,
            authority: executions.execution_authority_id,
            input: executions.input,
            caller: executions.caller_context,
            caller_origin: executions.caller_origin,
            authorization: executions.authorization_context,
            request_source: executions.request_source,
          })
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
      await auditAdmissionRefusal(
        {
          tenant_id: data.tenant_id,
          ...resolveExecutionCallerActor(data.tenant_id, boundary?.caller, boundary?.caller_origin),
          reason: "execution_authority_required",
          message,
          workflow_id: data.workflow_id,
          execution_id: data.execution_id ?? null,
          request_source: boundary?.request_source ?? (data.request_source as string) ?? "api",
          extra: { queue: EXECUTION_RUN_QUEUE },
        },
        db,
      );
      throw Object.assign(new Error(message), { code: "execution_authority_required" });
    }
    try {
      runOptions.caller_origin = resolveExecutionCallerOrigin(
        data.tenant_id,
        boundary.caller,
        boundary.caller_origin,
      );
      runOptions.caller_context = boundary.caller
        ? CallerContextSchema.parse(boundary.caller)
        : null;
      runOptions.principal = await rehydrateExecutionPrincipal(
        db,
        boundary.caller,
        boundary.authorization,
      );
      if (runOptions.principal) {
        const decision = await can(db, {
          tenant_id: data.tenant_id,
          principal: runOptions.principal,
          permission: "workflow:run",
          resource: { type: "workflow", id: data.workflow_id },
        });
        if (!decision.allow)
          throw Object.assign(new Error("The queued workflow is no longer authorized."), {
            code: "execution_authentication_unavailable",
          });
        if (data.execution_id && runOptions.caller_context) {
          await recordStartingWorkflowPermission(
            db,
            data.execution_id,
            runOptions.caller_context,
            await captureWorkflowPermission(
              db,
              runOptions.principal,
              data.workflow_id,
              decision,
              "start",
            ),
          );
        }
      }
    } catch (error) {
      const quotaCode = hostedContentQuotaCode(error);
      if (quotaCode && data.execution_id) {
        const finalized = await finalizeHostedContentQuota(db, {
          tenantId: data.tenant_id,
          resourceType: "execution",
          resourceId: data.execution_id,
          code: quotaCode,
        });
        if (finalized !== "unmatched") return;
        throw hostedQuotaError(error) ?? error;
      }
      await auditAwait(
        {
          tenant_id: data.tenant_id,
          ...resolveExecutionCallerActor(data.tenant_id, boundary.caller, boundary.caller_origin),
          action: AuditAction.POLICY_DENIED,
          resource_type: "execution",
          resource_id: data.execution_id ?? null,
          result: "denied",
          reason: "execution_authentication_unavailable",
          metadata: { workflow_id: data.workflow_id, request_source: boundary.request_source },
        },
        db,
      );
      throw error;
    }
    runOptions.resume_authorized = true;
    const result = await runExecution({
      db,
      tenant_id: data.tenant_id,
      source: { kind: "saved", workflow_id: data.workflow_id },
      input: boundary.input,
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
      const failed = {
        tenant_id: data.tenant_id,
        workflow_id: data.workflow_id,
        execution_id: result.execution_id,
      };
      await maybeEnqueueRepair(boss, db, failed);
      await maybeEnqueueGateDiagnosis(boss, db, failed);
    }
  } catch (caught) {
    const err = hostedQuotaError(caught) ?? caught;
    const quotaCode = hostedContentQuotaCode(err);
    if (quotaCode && data.execution_id) {
      const finalized = await finalizeHostedContentQuota(db, {
        tenantId: data.tenant_id,
        resourceType: "execution",
        resourceId: data.execution_id,
        code: quotaCode,
      });
      if (finalized !== "unmatched") return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.queue.job.failed({
      msg: "execution.run job failed",
      queue: EXECUTION_RUN_QUEUE,
      job_id: job.id,
      error: message,
      duration_ms: Date.now() - started,
    });
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
      } catch {}
    }
    throw err;
  }
}

export async function registerExecutionRunHandler(
  opts: RegisterExecutionRunOptions,
): Promise<string> {
  const { boss, db } = opts;
  let concurrency = 1;
  try {
    concurrency = getConfig().queue.concurrency;
  } catch {
    concurrency = 1;
  }
  const workerId = await boss.work<ExecutionRunJob>(
    EXECUTION_RUN_QUEUE,
    {
      batchSize: 1,
      localConcurrency: concurrency,
      groupConcurrency: hostedQueueGroupConcurrency("execution"),
      pollingIntervalSeconds: 1,
    },
    async (jobs: Job<ExecutionRunJob>[]) => {
      for (const job of jobs) {
        try {
          await withActiveTenantJobContext(job.data, db, async () => {
            const [boundary] = job.data.execution_id
              ? await db
                  .select({
                    origin_source: executions.origin_source,
                    audit_trace_id: executions.audit_trace_id,
                  })
                  .from(executions)
                  .where(
                    and(
                      eq(executions.tenant_id, job.data.tenant_id),
                      eq(executions.id, job.data.execution_id),
                    ),
                  )
                  .limit(1)
              : [];
            const originSource = RequestSourceSchema.safeParse(boundary?.origin_source);
            return withContext(
              {
                audit_origin_source: originSource.success ? originSource.data : undefined,
                audit_trace_id: boundary?.audit_trace_id ?? undefined,
              },
              () =>
                withHostedWork(
                  db,
                  job.data.tenant_id,
                  "execution",
                  () => handleOne(job, db, boss),
                  {
                    queue: EXECUTION_RUN_QUEUE,
                    id: job.id,
                  },
                ),
            );
          });
        } catch (error) {
          const quotaCode = hostedContentQuotaCode(error);
          if (quotaCode && job.data.execution_id) {
            const finalized = await finalizeHostedContentQuota(db, {
              tenantId: job.data.tenant_id,
              resourceType: "execution",
              resourceId: job.data.execution_id,
              code: quotaCode,
            });
            if (finalized !== "unmatched") continue;
          }
          if (error instanceof HostedWorkQuotaError && job.data.execution_id) {
            await ifHostedJobStillPending(
              db,
              job.data.tenant_id,
              EXECUTION_RUN_QUEUE,
              job.id,
              async () => {
                await finalizeExecution(
                  db,
                  job.data.tenant_id,
                  job.data.execution_id ?? "",
                  "failed",
                  null,
                  { step_id: null, error_code: error.code, error_message: error.message },
                  ["queued"],
                );
              },
            );
          }
          throw error;
        }
      }
    },
  );
  log.queue.worker.registered({
    msg: "execution.run worker registered",
    worker_id: workerId,
  });
  return workerId;
}
