import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  type ConversationTurnOutcome,
  describeTurnFailure,
  humanInBandAnswer,
  humanPortalAnswer,
  isExpectedCancellation,
  MODEL_RELAYED_ANSWER,
  runConversationTurn,
} from "../../conversations/public/authoring.ts";
import {
  ElicitationValidationError,
  getElicitation,
  respondElicitation,
} from "../../conversations/public/elicitation.ts";
import {
  bindConversationTurn,
  clearConversationTurnFailure,
  conversationTurnId,
  finishConversationTurn,
  parkConversationTurn,
  recordConversationTurnFailure,
  registerConversationAbort,
  reserveConversationTurn,
  stopConversationTaskTurn,
  unregisterConversationAbort,
} from "../../conversations/public/lifecycle.ts";
import type { Db } from "../../db/client.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import { conversationMessages, users } from "../../db/schema/index.ts";
import {
  authorizationContextFromPrincipal,
  rehydrateExecutionPrincipal,
} from "../../execution/authorization-context.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { getContext, type LogContext, withContext } from "../../logging/context.ts";
import { log } from "../../logging/logger.ts";
import {
  type ConversationTurnEnvelope,
  clearMcpTaskPark,
  getMcpTask,
  laterTurnCompleted,
  type McpTaskRow,
  setMcpTaskFailure,
  setMcpTaskFailureIfNotTerminal,
  setMcpTaskJobId,
  setMcpTaskParked,
  setMcpTaskResult,
  setMcpTaskResultIfCurrentAttempt,
} from "../../mcp/tasks/store.ts";
import { readMemoryUsage } from "../../observability/runtime-telemetry.ts";
import { RequestSourceSchema } from "../../observability/service-metadata.ts";
import { can } from "../../rbac/evaluator.ts";
import { recordUsageEvent } from "../../stats/usage-events.ts";
import {
  finalizeHostedContentQuota,
  hostedContentQuotaCode,
} from "../hosted-content-finalization.ts";
import {
  enqueueHostedWork,
  HostedWorkQuotaError,
  hostedQueueGroupConcurrency,
  ifHostedJobStillPending,
  queueWorkerConcurrency,
  withHostedWork,
} from "../hosted-work.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { CONVERSATION_RUN_TURN_QUEUE, type ConversationRunTurnJob } from "../queues.ts";
import { planProviderLimitPark } from "./provider-limit-park.ts";

interface RegisterConversationRunTurnOptions {
  boss: PgBoss;
  db: Db;
}

const NATIVE_ELICITATION_CANCELLATION_REASONS = new Set([
  "user_declined",
  "user_cancelled",
  "external_interaction_failed",
  "invalid_elicit_response",
]);

async function userMessageTextById(
  db: Db,
  tenant_id: string,
  conversation_id: string,
  message_id: string,
): Promise<string> {
  const [row] = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
        eq(conversationMessages.id, message_id),
      ),
    )
    .limit(1);
  if (!row) throw new Error("turn message does not belong to this conversation");
  const content = row?.content as { text?: unknown } | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

function toEnvelope(outcome: ConversationTurnOutcome): ConversationTurnEnvelope {
  return {
    conversation_id: outcome.conversation.id,
    ...(outcome.turn_id ? { turn_id: outcome.turn_id } : {}),
    status: outcome.result.status,
    events: outcome.result.events,
    ...(outcome.result.pending_elicitation_id
      ? { pending_elicitation_id: outcome.result.pending_elicitation_id }
      : {}),
    ...(outcome.result.committed_workflow_id
      ? { committed_workflow_id: outcome.result.committed_workflow_id }
      : {}),
  };
}

async function storeAttemptResult(
  data: ConversationRunTurnJob,
  result: ConversationTurnEnvelope,
  db: Db,
  turnId: string | undefined,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const stored = data.attempt_id
      ? await setMcpTaskResultIfCurrentAttempt(
          data.tenant_id,
          data.mcp_task_id,
          data.attempt_id,
          result,
          tx,
        )
      : await setMcpTaskResult(data.tenant_id, data.mcp_task_id, result, tx).then(() => true);
    if (stored && turnId)
      await finishConversationTurn(
        tx,
        data.tenant_id,
        data.conversation_id,
        turnId,
        "completed",
        data.attempt_id,
      );
    return stored;
  });
}

async function storeAttemptFailure(
  data: ConversationRunTurnJob,
  attempt_id: string | undefined,
  failure_reason: string,
  db: Db,
): Promise<boolean> {
  if (attempt_id) {
    return await setMcpTaskFailureIfNotTerminal(
      data.tenant_id,
      data.mcp_task_id,
      failure_reason,
      db,
      attempt_id,
    );
  }
  await setMcpTaskFailure(data.tenant_id, data.mcp_task_id, failure_reason, db);
  return true;
}

export const SUPERSEDED_WHILE_PARKED_FAILURE_REASON = "superseded_while_parked";

async function failureActor(data: ConversationRunTurnJob, task: McpTaskRow, db: Db) {
  if (
    data.answer_channel === "portal" &&
    data.approver_user_id &&
    data.actor_id === data.approver_user_id
  ) {
    const [approver] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, data.tenant_id),
          eq(users.id, data.approver_user_id),
          eq(users.status, "active"),
          isNull(users.deleted_at),
        ),
      )
      .limit(1);
    return approver
      ? resolveActor({ actor_type: "user", actor_id: approver.id })
      : resolveActor({ actor_type: "unknown", actor_id: null });
  }
  return resolveActor({ actor_type: task.actor_kind ?? "unknown", actor_id: task.actor_id });
}

async function handleOne(job: Job<ConversationRunTurnJob>, db: Db, boss: PgBoss): Promise<void> {
  const data = job.data;
  log.queue.job.dequeued({
    msg: "conversation.run-turn job dequeued",
    queue: CONVERSATION_RUN_TURN_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
  });
  const started = Date.now();

  const task = await getMcpTask(data.tenant_id, data.mcp_task_id, db);
  if (!task) {
    log.queue.job.failed({
      msg: "conversation.run-turn job has no mcp_tasks row — dropping",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      error: "mcp_task_not_found",
      duration_ms: Date.now() - started,
    });
    return;
  }
  if (task.conversation_id !== data.conversation_id) throw new Error("task conversation mismatch");
  if (data.attempt_id && task.job_id !== data.attempt_id) {
    log.queue.job.completed({
      msg: "conversation.run-turn queue attempt was superseded — idempotent no-op",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      tenant_id: data.tenant_id,
      duration_ms: Date.now() - started,
    });
    return;
  }
  if (task.result || task.failure_reason || task.cancelled_at) {
    if (data.turn_id && data.attempt_id)
      await stopConversationTaskTurn(
        db,
        data.tenant_id,
        data.conversation_id,
        data.turn_id,
        data.mcp_task_id,
        data.attempt_id,
        task.cancelled_at ? "cancelled" : task.failure_reason ? "failed" : "completed",
      );
    log.queue.job.completed({
      msg: "conversation.run-turn job already terminal — idempotent no-op",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      duration_ms: Date.now() - started,
    });
    return;
  }

  if (task.parked_until) {
    const superseded = await laterTurnCompleted(
      data.tenant_id,
      data.conversation_id,
      task.turn_seq,
      db,
    );
    if (superseded) {
      await setMcpTaskFailureIfNotTerminal(
        data.tenant_id,
        data.mcp_task_id,
        SUPERSEDED_WHILE_PARKED_FAILURE_REASON,
        db,
      );
      log.queue.job.completed({
        msg: "conversation.run-turn parked turn superseded by a later completed turn — not run",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        duration_ms: Date.now() - started,
      });
      return;
    }
  }

  if ((data.provider_limit_parks ?? 0) > 0) {
    await clearMcpTaskPark(data.tenant_id, data.mcp_task_id, db);
  }

  let turnAbortCtrl: AbortController | undefined;
  let turnId: string | undefined;
  const rssBefore = readMemoryUsage().rss;
  try {
    turnAbortCtrl = await registerConversationAbort(
      data.tenant_id,
      data.conversation_id,
      db,
      data.turn_id ? { turn_id: data.turn_id, attempt_id: data.attempt_id ?? job.id } : undefined,
    );
    turnId = conversationTurnId(turnAbortCtrl);
    const recheck = await getMcpTask(data.tenant_id, data.mcp_task_id, db);
    if (turnAbortCtrl.signal.aborted || recheck?.cancelled_at || recheck?.failure_reason) {
      await unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl);
      log.queue.job.completed({
        msg: "conversation.run-turn cancelled before turn start",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    await clearConversationTurnFailure(db, data.tenant_id, data.conversation_id);

    const principal = await rehydrateExecutionPrincipal(
      db,
      callerFromPrincipal(data.principal, data.tenant_id, data.principal?.product_id),
      authorizationContextFromPrincipal(data.principal),
    );
    if (!principal)
      throw Object.assign(
        new Error("Queued conversation requires authenticated credential provenance."),
        {
          code: "execution_authentication_unavailable",
        },
      );
    const decisions = await Promise.all(
      ["conversation:write", "workflow:write"].map((permission) =>
        can(db, { tenant_id: data.tenant_id, principal, permission }),
      ),
    );
    if (!decisions.some((decision) => decision.allow))
      throw Object.assign(new Error("The queued conversation is no longer authorized."), {
        code: "execution_authentication_unavailable",
      });
    let outcome: ConversationTurnOutcome;
    if (data.kind === "respond_elicitation") {
      if (!data.elicitation_id) {
        throw new Error("respond_elicitation job missing elicitation_id");
      }
      const elicitation = await getElicitation(data.tenant_id, data.elicitation_id, db);
      if (!elicitation || elicitation.conversation_id !== data.conversation_id) {
        throw new Error("respond_elicitation job has no conversation_elicitations row");
      }
      outcome = await respondElicitation(
        {
          tenant_id: data.tenant_id,
          conversation_id: data.conversation_id,
          elicitation_id: data.elicitation_id,
          actor_id: data.actor_id,
          principal,
          answer_actor:
            data.answer_channel === "mcp_native"
              ? humanInBandAnswer(principal)
              : data.answer_channel === "portal"
                ? humanPortalAnswer(data.approver_user_id)
                : MODEL_RELAYED_ANSWER,
          output: elicitation.output,
          ...(data.answer_channel === "mcp_native" &&
          data.reason &&
          NATIVE_ELICITATION_CANCELLATION_REASONS.has(data.reason)
            ? { resolution_status: "cancelled" as const }
            : {}),
          surface: "mcp",
          turn_abort_ctrl: turnAbortCtrl,
          ...(data.reason ? { reason: data.reason } : {}),
          ...(data.permission_mode ? { permission_mode: data.permission_mode } : {}),
        },
        db,
      );
    } else {
      if (!task.user_message_id) {
        throw new Error(`${data.kind} job has no user_message_id on the mcp_tasks row`);
      }
      const message = await userMessageTextById(
        db,
        data.tenant_id,
        data.conversation_id,
        task.user_message_id,
      );
      outcome = await runConversationTurn(
        {
          tenant_id: data.tenant_id,
          conversation_id: data.conversation_id,
          actor_id: data.actor_id,
          principal,
          user_message: message,
          answer_actor: MODEL_RELAYED_ANSWER,
          surface: "mcp",
          turn_abort_ctrl: turnAbortCtrl,
          ...(data.permission_mode ? { permission_mode: data.permission_mode } : {}),
          ...(data.runtime_context ? { runtime_context: data.runtime_context } : {}),
        },
        db,
      );
    }

    const resultStored = await storeAttemptResult(data, toEnvelope(outcome), db, turnId);
    if (!resultStored) {
      log.queue.job.completed({
        msg: "conversation.run-turn completed after a newer attempt took ownership — stale result discarded",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        tenant_id: data.tenant_id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    recordUsageEvent(db, {
      tenantId: data.tenant_id,
      surface: "conversations",
      operation: "mcp/turn",
      method: "EVENT",
      outcome: "success",
      requestSource: task.request_source,
      actorId: task.actor_id,
      sessionId: data.conversation_id,
      durationMs: Date.now() - started,
      platform: "http",
      responseMode: "async",
      taskPhase: outcome.result.status === "awaiting_input" ? "input_required" : "completed",
    });
    log.queue.job.completed({
      msg: "conversation.run-turn job completed",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      tenant_id: data.tenant_id,
      duration_ms: Date.now() - started,
      rss_mb: Math.round((readMemoryUsage().rss / 1048576) * 10) / 10,
      rss_delta_mb: Math.round(((readMemoryUsage().rss - rssBefore) / 1048576) * 10) / 10,
    });
  } catch (caught) {
    const err = hostedQuotaError(caught) ?? caught;
    const quotaCode = hostedContentQuotaCode(err);
    if (quotaCode) {
      const finalized = await finalizeHostedContentQuota(db, {
        tenantId: data.tenant_id,
        resourceType: "mcp_task",
        resourceId: data.mcp_task_id,
        code: quotaCode,
        expectedJobId: data.attempt_id ?? job.id,
      });
      if (finalized !== "unmatched") return;
    }
    if (!turnAbortCtrl) throw err;
    const refusalCode = (err as { code?: string }).code;
    const authenticationRefusal =
      refusalCode === "execution_authentication_unavailable" ||
      (refusalCode?.startsWith("caller_") ?? false);
    const actor = await failureActor(data, task, db);
    if (authenticationRefusal) {
      await auditAwait(
        {
          tenant_id: data.tenant_id,
          ...actor,
          action: AuditAction.POLICY_DENIED,
          resource_type: "conversation",
          resource_id: data.conversation_id,
          result: "denied",
          reason: refusalCode ?? "caller_authentication_unavailable",
          metadata: { mcp_task_id: data.mcp_task_id, request_source: task.request_source },
        },
        db,
      );
    }
    if (isExpectedCancellation(err, turnAbortCtrl.signal)) {
      log.queue.job.completed({
        msg: "conversation.run-turn cancelled",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    if (err instanceof ElicitationValidationError) {
      const validationResult = {
        conversation_id: data.conversation_id,
        status: "awaiting_input",
        events: [
          {
            type: "validation_error",
            errors: err.field_errors.map((fe) => ({ path: fe.name, message: fe.message })),
          },
        ],
        pending_elicitation_id: err.elicitation_id,
      } satisfies ConversationTurnEnvelope;
      const validationStored = await storeAttemptResult(data, validationResult, db, turnId);
      if (!validationStored) return;
      recordUsageEvent(db, {
        tenantId: data.tenant_id,
        surface: "conversations",
        operation: "mcp/turn",
        method: "EVENT",
        outcome: "success",
        requestSource: task.request_source,
        actorId: task.actor_id,
        sessionId: data.conversation_id,
        durationMs: Date.now() - started,
        platform: "http",
        responseMode: "async",
        taskPhase: "input_required",
      });
      log.queue.job.completed({
        msg: "conversation.run-turn elicitation answer failed validation — row stays pending",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        tenant_id: data.tenant_id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    const parkPlan = planProviderLimitPark(err, data.provider_limit_parks ?? 0, Date.now());
    let failureAttemptId = data.attempt_id;
    if (parkPlan) {
      try {
        await parkConversationTurn(data.tenant_id, data.conversation_id, turnAbortCtrl);
        const retryAttemptId = randomUUID();
        await setMcpTaskJobId(data.tenant_id, data.mcp_task_id, retryAttemptId, db);
        failureAttemptId = retryAttemptId;
        const retryJobId = await enqueueConversationRunTurn(
          boss,
          db,
          { ...data, ...(turnId ? { turn_id: turnId } : {}), provider_limit_parks: parkPlan.parks },
          { id: retryAttemptId, startAfter: parkPlan.start_after },
        );
        if (retryJobId !== retryAttemptId) throw new Error("queue rejected the parked retry job");
        await setMcpTaskParked(
          data.tenant_id,
          data.mcp_task_id,
          parkPlan.start_after,
          `provider_${parkPlan.kind}`,
          db,
        );
        log.queue.job.completed({
          msg: "conversation.run-turn hit a provider usage limit — parked for retry",
          queue: CONVERSATION_RUN_TURN_QUEUE,
          job_id: job.id,
          tenant_id: data.tenant_id,
          error: err instanceof Error ? err.message : String(err),
          provider_limit_kind: parkPlan.kind,
          provider_limit_parks: parkPlan.parks,
          park_source: parkPlan.source,
          start_after: parkPlan.start_after.toISOString(),
          duration_ms: Date.now() - started,
        });
        return;
      } catch (sendErr) {
        if (turnId)
          await finishConversationTurn(
            db,
            data.tenant_id,
            data.conversation_id,
            turnId,
            "failed",
            data.attempt_id,
          );
        log.queue.job.failed({
          msg: "conversation.run-turn park re-enqueue failed — falling back to terminal failure",
          queue: CONVERSATION_RUN_TURN_QUEUE,
          job_id: job.id,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          duration_ms: Date.now() - started,
        });
      }
    }
    const turnFailure = describeTurnFailure(err);
    const failureReason = turnFailure.message;
    const failureStored = await storeAttemptFailure(data, failureAttemptId, failureReason, db);
    if (!failureStored) {
      log.queue.job.completed({
        msg: "conversation.run-turn failed after a newer attempt took ownership — stale failure discarded",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        tenant_id: data.tenant_id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    await recordConversationTurnFailure(db, data.tenant_id, data.conversation_id, turnFailure);
    recordUsageEvent(db, {
      tenantId: data.tenant_id,
      surface: "conversations",
      operation: "mcp/turn",
      method: "EVENT",
      outcome: "server_error",
      requestSource: task.request_source,
      actorId: task.actor_id,
      sessionId: data.conversation_id,
      durationMs: Date.now() - started,
      platform: "http",
      responseMode: "async",
      taskPhase: "failed",
    });
    await auditAwait(
      {
        tenant_id: data.tenant_id,
        ...actor,
        action: AuditAction.CONVERSATION_TURN_FAILED,
        resource_type: "conversation",
        resource_id: data.conversation_id,
        result: "error",
        reason: failureReason,
        metadata: {
          mcp_task_id: data.mcp_task_id,
          kind: data.kind,
          request_source: task.request_source,
        },
      },
      db,
    );
    log.queue.job.failed({
      msg: "conversation.run-turn job failed",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      error: failureReason,
      duration_ms: Date.now() - started,
    });
    throw err;
  } finally {
    if (turnAbortCtrl)
      await unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl);
  }
}

export async function registerConversationRunTurnHandler(
  opts: RegisterConversationRunTurnOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<ConversationRunTurnJob>(
    CONVERSATION_RUN_TURN_QUEUE,
    {
      batchSize: 1,
      localConcurrency: queueWorkerConcurrency(),
      groupConcurrency: hostedQueueGroupConcurrency("chat"),
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<ConversationRunTurnJob>[]) => {
      for (const job of jobs) {
        let settlementContext: LogContext | undefined;
        try {
          await withActiveTenantJobContext(job.data, db, async () => {
            const task = await getMcpTask(job.data.tenant_id, job.data.mcp_task_id, db);
            const originSource = RequestSourceSchema.safeParse(task?.origin_source);
            return withContext(
              {
                audit_origin_source: originSource.success ? originSource.data : undefined,
                audit_trace_id: task?.audit_trace_id ?? undefined,
              },
              () => {
                settlementContext = { ...getContext() };
                return withHostedWork(
                  db,
                  job.data.tenant_id,
                  "chat",
                  () => handleOne(job, db, boss),
                  {
                    queue: CONVERSATION_RUN_TURN_QUEUE,
                    id: job.id,
                  },
                );
              },
            );
          });
        } catch (error) {
          const quotaCode = hostedContentQuotaCode(error);
          if (quotaCode) {
            const finalized = await withContext(settlementContext ?? {}, () =>
              finalizeHostedContentQuota(db, {
                tenantId: job.data.tenant_id,
                resourceType: "mcp_task",
                resourceId: job.data.mcp_task_id,
                code: quotaCode,
                expectedJobId: job.data.attempt_id ?? job.id,
              }),
            );
            if (finalized !== "unmatched") continue;
          }
          if (error instanceof HostedWorkQuotaError) {
            await withContext(settlementContext ?? {}, () =>
              ifHostedJobStillPending(
                db,
                job.data.tenant_id,
                CONVERSATION_RUN_TURN_QUEUE,
                job.id,
                async (tx) => {
                  const changed = await setMcpTaskFailureIfNotTerminal(
                    job.data.tenant_id,
                    job.data.mcp_task_id,
                    error.code,
                    tx,
                    job.data.attempt_id,
                  );
                  if (changed)
                    await auditAwait(
                      {
                        tenant_id: job.data.tenant_id,
                        action: AuditAction.CONVERSATION_TURN_FAILED,
                        actor_type: "system",
                        resource_type: "conversation",
                        resource_id: job.data.conversation_id,
                        result: "error",
                        reason: error.code,
                      },
                      tx,
                    );
                },
              ),
            );
          }
          throw error;
        }
      }
    },
  );
  log.queue.worker.registered({
    msg: "conversation.run-turn worker registered",
    worker_id: workerId,
  });
  return workerId;
}

export async function enqueueConversationRunTurn(
  boss: PgBoss,
  db: Db,
  payload: ConversationRunTurnJob,
  options: { id?: string; startAfter?: Date } = {},
): Promise<string | null> {
  const { id, ...sendOptions } = options;
  const turnId =
    payload.turn_id ??
    (await reserveConversationTurn(db, payload.tenant_id, payload.conversation_id));
  const attempt = id ?? randomUUID();
  let bound = false;
  try {
    if (!id) await setMcpTaskJobId(payload.tenant_id, payload.mcp_task_id, attempt, db);
    await bindConversationTurn(
      db,
      payload.tenant_id,
      payload.conversation_id,
      turnId,
      payload.mcp_task_id,
      attempt,
      payload.attempt_id,
    );
    bound = true;
    const queued = await enqueueHostedWork(
      db,
      boss,
      "chat",
      CONVERSATION_RUN_TURN_QUEUE,
      { ...payload, turn_id: turnId, attempt_id: attempt },
      { ...sendOptions, id: attempt },
    );
    if (!queued)
      await finishConversationTurn(
        db,
        payload.tenant_id,
        payload.conversation_id,
        turnId,
        "failed",
        attempt,
      );
    return queued;
  } catch (error) {
    await finishConversationTurn(
      db,
      payload.tenant_id,
      payload.conversation_id,
      turnId,
      "failed",
      bound ? attempt : (payload.attempt_id ?? null),
    );
    throw error;
  }
}
