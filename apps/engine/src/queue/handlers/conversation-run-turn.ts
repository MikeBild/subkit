import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditActor } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  isExpectedCancellation,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import {
  humanInBandAnswer,
  humanPortalAnswer,
  MODEL_RELAYED_ANSWER,
} from "../../conversations/answer-actor.ts";
import { decidedByFor } from "../../conversations/decided-by.ts";
import * as svc from "../../conversations/service.ts";
import { describeTurnFailure } from "../../conversations/turn-failure.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
import {
  authorizationContextFromPrincipal,
  rehydrateExecutionPrincipal,
} from "../../execution/authorization-context.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { log } from "../../logging/logger.ts";
import {
  type ConversationTurnEnvelope,
  clearMcpTaskPark,
  getMcpTask,
  laterTurnCompleted,
  setMcpTaskFailure,
  setMcpTaskFailureIfNotTerminal,
  setMcpTaskJobId,
  setMcpTaskParked,
  setMcpTaskResult,
  setMcpTaskResultIfCurrentAttempt,
} from "../../mcp/tasks/store.ts";
import { readMemoryUsage } from "../../observability/runtime-telemetry.ts";
import { can } from "../../rbac/evaluator.ts";
import { recordUsageEvent } from "../../stats/usage-events.ts";
import { withJobContext } from "../job-context.ts";
import { CONVERSATION_RUN_TURN_QUEUE, type ConversationRunTurnJob } from "../queues.ts";
import { planProviderLimitPark } from "./provider-limit-park.ts";

export interface RegisterConversationRunTurnOptions {
  boss: PgBoss;
  db: Db;
}

const NATIVE_ELICITATION_CANCELLATION_REASONS = new Set([
  "user_declined",
  "user_cancelled",
  "external_interaction_failed",
  "invalid_elicit_response",
]);

async function userMessageTextById(db: Db, tenant_id: string, message_id: string): Promise<string> {
  const [row] = await db
    .select({ content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(eq(conversationMessages.tenant_id, tenant_id), eq(conversationMessages.id, message_id)),
    )
    .limit(1);
  const content = row?.content as { text?: unknown } | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

function toEnvelope(outcome: svc.ConversationTurnOutcome): ConversationTurnEnvelope {
  return {
    conversation_id: outcome.conversation.id,
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
): Promise<boolean> {
  if (data.attempt_id) {
    return await setMcpTaskResultIfCurrentAttempt(
      data.tenant_id,
      data.mcp_task_id,
      data.attempt_id,
      result,
      db,
    );
  }
  await setMcpTaskResult(data.tenant_id, data.mcp_task_id, result, db);
  return true;
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

  const turnAbortCtrl = registerConversationAbort(data.tenant_id, data.conversation_id);
  const recheck = await getMcpTask(data.tenant_id, data.mcp_task_id, db);
  if (turnAbortCtrl.signal.aborted || recheck?.cancelled_at || recheck?.failure_reason) {
    unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl);
    log.queue.job.completed({
      msg: "conversation.run-turn cancelled before turn start",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      duration_ms: Date.now() - started,
    });
    return;
  }

  const rssBefore = readMemoryUsage().rss;
  try {
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
    let outcome: svc.ConversationTurnOutcome;
    if (data.kind === "respond_elicitation") {
      if (!data.elicitation_id) {
        throw new Error("respond_elicitation job missing elicitation_id");
      }
      const { getElicitation } = await import("../../conversations/elicitations.ts");
      const elicitation = await getElicitation(data.tenant_id, data.elicitation_id, db);
      if (!elicitation) {
        throw new Error("respond_elicitation job has no conversation_elicitations row");
      }
      outcome = await svc.respondElicitation(
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
      const message = await userMessageTextById(db, data.tenant_id, task.user_message_id);
      outcome = await svc.runConversationTurn(
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

    const resultStored = await storeAttemptResult(data, toEnvelope(outcome), db);
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
  } catch (err) {
    const refusalCode = (err as { code?: string }).code;
    if (
      refusalCode === "execution_authentication_unavailable" ||
      refusalCode?.startsWith("caller_")
    ) {
      await auditAwait(
        {
          tenant_id: data.tenant_id,
          actor_type: data.principal?.kind ?? "system",
          actor_id: data.principal?.id ?? null,
          action: AuditAction.POLICY_DENIED,
          resource_type: "conversation",
          resource_id: data.conversation_id,
          result: "denied",
          reason: refusalCode,
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
    if (err instanceof svc.ElicitationValidationError) {
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
      const validationStored = await storeAttemptResult(data, validationResult, db);
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
        const retryAttemptId = randomUUID();
        await setMcpTaskJobId(data.tenant_id, data.mcp_task_id, retryAttemptId, db);
        failureAttemptId = retryAttemptId;
        const retryJobId = await enqueueConversationRunTurn(
          boss,
          { ...data, provider_limit_parks: parkPlan.parks },
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
        log.queue.job.failed({
          msg: "conversation.run-turn park re-enqueue failed — falling back to terminal failure",
          queue: CONVERSATION_RUN_TURN_QUEUE,
          job_id: job.id,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          duration_ms: Date.now() - started,
        });
      }
    }
    const failureReason = describeTurnFailure(err).message;
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
        ...auditActor(decidedByFor(data.actor_id, data.principal)),
        action: AuditAction.CONVERSATION_TURN_FAILED,
        resource_type: "conversation",
        resource_id: data.conversation_id,
        result: "error",
        reason: failureReason,
        metadata: { mcp_task_id: data.mcp_task_id, kind: data.kind },
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
    unregisterConversationAbort(data.tenant_id, data.conversation_id, turnAbortCtrl);
  }
}

export async function registerConversationRunTurnHandler(
  opts: RegisterConversationRunTurnOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<ConversationRunTurnJob>(
    CONVERSATION_RUN_TURN_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async (jobs: Job<ConversationRunTurnJob>[]) => {
      for (const job of jobs) {
        await withJobContext(job.data, () => handleOne(job, db, boss));
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
  payload: ConversationRunTurnJob,
  options: { id?: string; startAfter?: Date } = {},
): Promise<string | null> {
  const { id, ...sendOptions } = options;
  return await boss.send(
    CONVERSATION_RUN_TURN_QUEUE,
    { ...payload, ...(id ? { attempt_id: id } : {}) },
    { ...sendOptions, ...(id ? { id } : {}) },
  );
}
