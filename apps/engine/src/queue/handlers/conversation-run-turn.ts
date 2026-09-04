// Worker for the `conversation.run-turn` queue.
//
// Runs ONE backgrounded conversation turn for the MCP async-Tasks path
// (SEP-1686). The MCP `tools/call` handler already (a) inserted/
// validated the conversation row, (b) persisted the user message row,
// (c) inserted the `mcp_tasks` index row with `user_message_id`, then
// returned fast. This worker does the slow part — the model loop — so
// the client never holds the call open for the 68-160s a real turn
// takes.
//
// `retryLimit` is 0 (see queues.ts): a turn makes real, non-idempotent
// LLM + external calls. A throw lands the job in
// `conversation.run-turn.dlq`. TWO terminal-writers protect the
// `mcp_tasks` row from a stuck `working` state:
//   - this worker's own success / `catch` writes `result` /
//     `failure_reason` for a turn it completed or threw inside;
//   - the DLQ consumer (`conversation-run-turn-dlq.ts`) marks the row
//     `failed` with `worker_expired` when the worker PROCESS died
//     mid-turn (an OOM restart) and pg-boss expired the job — the
//     `catch` never ran, so without the DLQ consumer the task would
//     poll `working` forever.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
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
import * as svc from "../../conversations/service.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
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

/**
 * Read the user message text for THIS turn by its
 * `conversation_messages` row id. The MCP tool handler captured the id
 * when it persisted the message and pinned it onto the `mcp_tasks`
 * row, so the worker runs the turn on the exact message that drove the
 * call — never the most-recent row, which a concurrent turn could have
 * overwritten (two `conversation_append`s, or a `start` racing an
 * `append`, on one conversation).
 */
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
  // Compatibility for queue rows created before attempt fencing was added.
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
  // Compatibility for queue rows created before attempt fencing was added.
  await setMcpTaskFailure(data.tenant_id, data.mcp_task_id, failure_reason, db);
  return true;
}

/**
 * Machine-readable failure code for a parked turn the conversation
 * outran. Named for the only condition under which it is stamped.
 */
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

  // (a) Load the index row. pg-boss is at-least-once: a job redelivered
  // after the worker already finished must be a no-op. A row whose
  // result / failure_reason / cancelled_at is already set is terminal.
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

  // (a1) A parked turn that the conversation outran.
  //
  // `planProviderLimitPark` defers a turn until the provider's quota
  // resets — up to 45 days — and nothing stops the operator from simply
  // retrying in the meantime. Measured on 2026-08-18: turns 1 and 2 parked
  // on an exhausted quota, the retry went through as turns 3-5, the
  // conversation committed, and the two parked turns stayed runnable with
  // the original admin principal's authoring scopes against a workflow
  // that had since gone live. Guard (a) does not catch them — "superseded"
  // is not one of its three terminal columns.
  //
  // The predicate is deliberately narrow and fires ONLY on a parked turn.
  // MCP turns are not serialized — `withConversationTurnLock` guards the
  // chat surface, not this one — so an ordinary queued turn may sit behind
  // a later one that finishes first, and discarding it would silently drop
  // a user message.
  //
  // `parked_until` in the past is exactly the state a waking park is in,
  // so this reads the column for presence, unlike `getMcpTaskPark` which
  // treats an elapsed deadline as no longer parked.
  //
  // Stamped as a failure_reason, without an audit row or usage event: the
  // turn never ran, charged nothing and broke nothing, so recording an
  // operator-facing turn failure would put a false entry in the record.
  // The stamp exists so the task stops deriving `working` forever.
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

  // (a2) The turn is running now, so it is no longer parked. Clearing the
  // stamp here — not at park time — keeps the reason visible for the whole
  // wait and removes it the moment it stops being true.
  if ((data.provider_limit_parks ?? 0) > 0) {
    await clearMcpTaskPark(data.tenant_id, data.mcp_task_id, db);
  }

  // (b) Register the AbortController so `tasks/cancel` can stop the
  // turn promptly via `cancelConversationAbort`.
  const turnAbortCtrl = registerConversationAbort(data.tenant_id, data.conversation_id);
  // (c) Close the cancel TOCTOU window. A `tasks/cancel` can land in
  // three places: before the entry guard at (a) (caught there), after
  // `registerConversationAbort` (the controller is aborted directly —
  // caught by `turnAbortCtrl.signal.aborted`), or in between — the
  // cancel stamped `cancelled_at` AND called `cancelConversationAbort`
  // against a controller that did not exist yet, so the abort was
  // lost. Re-read the row: if `cancelled_at` is now set, the turn must
  // not run.
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

  // Bracket the heavy model loop with an rss baseline so the success
  // log can attribute the multi-GB transient to THIS turn/tenant.
  const rssBefore = readMemoryUsage().rss;
  try {
    // (d) Dispatch by kind. NOTE: NO `elicitationBridge` is passed — a
    // backgrounded turn has no live MCP session, so input-collecting
    // tools take the DB-pause path (insert a pending
    // `conversation_elicitations` row, set conversations.status =
    // awaiting_input). The task then derives `input_required`.
    let outcome: svc.ConversationTurnOutcome;
    if (data.kind === "respond_elicitation") {
      if (!data.elicitation_id) {
        throw new Error("respond_elicitation job missing elicitation_id");
      }
      // (e) The answer was staged onto `conversation_elicitations.output`
      // before enqueue — read it back rather than carrying it inline in
      // the 8 KB job envelope. The row is still `pending`; `respondElicitation`
      // drives the real resolve.
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
          // Thread the initiating principal so a run_workflow resumed
          // from an elicitation also runs under RBAC instead of failing
          // principal_required.
          ...(data.principal ? { principal: data.principal } : {}),
          // WHO answered, per the channel that carried it:
          //   - `mcp_native` — the client fulfilled an `elicitation/create`
          //     round-trip, which it can only do by showing a person the prompt.
          //   - `portal` — a person decided in the browser approval portal,
          //     which already granted the `tool_approvals` row inside their own
          //     request; this names them so the resume is not filed as a machine
          //     relay. An unidentified browser degrades to a relay.
          //   - anything else — the MODEL called
          //     `conversation_respond_elicitation` and this worker only carried
          //     the answer across a queue. It authenticates as a user principal
          //     and is still not a person, so it grants nothing.
          answer_actor:
            data.answer_channel === "mcp_native"
              ? humanInBandAnswer(data.principal)
              : data.answer_channel === "portal"
                ? humanPortalAnswer(data.approver_user_id)
                : MODEL_RELAYED_ANSWER,
          output: elicitation.output,
          ...(data.answer_channel === "mcp_native" &&
          data.reason &&
          NATIVE_ELICITATION_CANCELLATION_REASONS.has(data.reason)
            ? { resolution_status: "cancelled" as const }
            : {}),
          // The resumed runLoop runs on the MCP surface — without this the
          // inner confirm gate and prompt variants would treat the resumed
          // turn as a default (chat-capable) one and pause enumerated
          // collapsible writes on approvals no human can reach.
          surface: "mcp",
          turn_abort_ctrl: turnAbortCtrl,
          ...(data.reason ? { reason: data.reason } : {}),
          ...(data.permission_mode ? { permission_mode: data.permission_mode } : {}),
        },
        db,
      );
    } else {
      // (f) `start` / `append` — run the turn on the EXACT user message
      // the handler pinned, not the most-recent row.
      if (!task.user_message_id) {
        throw new Error(`${data.kind} job has no user_message_id on the mcp_tasks row`);
      }
      const message = await userMessageTextById(db, data.tenant_id, task.user_message_id);
      outcome = await svc.runConversationTurn(
        {
          tenant_id: data.tenant_id,
          conversation_id: data.conversation_id,
          actor_id: data.actor_id,
          // Thread the initiating principal so RBAC-gated tools
          // (run_workflow) execute instead of failing principal_required.
          ...(data.principal ? { principal: data.principal } : {}),
          user_message: message,
          // The "user message" on this path was authored by the model calling
          // `conversation_start` / `conversation_append`. A fast-path
          // affirmation in it approves nothing.
          answer_actor: MODEL_RELAYED_ANSWER,
          surface: "mcp",
          turn_abort_ctrl: turnAbortCtrl,
          ...(data.permission_mode ? { permission_mode: data.permission_mode } : {}),
          ...(data.runtime_context ? { runtime_context: data.runtime_context } : {}),
        },
        db,
      );
    }

    // (g) Success — persist the terminal CallToolResult envelope. A native
    // resume reuses the MCP task id, so the pausing attempt is allowed to
    // finish unwinding only if it still owns `job_id`.
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
    // (h) Distinguish a cancellation from a real failure. A cancel is
    // an expected terminal state — `cancelled_at` is already (or about
    // to be) set by the TaskStore; do NOT overwrite it with a failure
    // or emit a failure audit row.
    if (isExpectedCancellation(err, turnAbortCtrl.signal)) {
      log.queue.job.completed({
        msg: "conversation.run-turn cancelled",
        queue: CONVERSATION_RUN_TURN_QUEUE,
        job_id: job.id,
        duration_ms: Date.now() - started,
      });
      return;
    }
    // A validation rejection is NOT a turn failure: the elicitation row
    // stays `pending` (the re-prompt) and the staged output is
    // deterministically invalid — a pg-boss retry would re-read the same
    // staged answer and fail identically 3× into the DLQ. Persist a
    // result envelope carrying the field errors (the task store derives
    // `input_required` from the still-pending row, so `tasks/get`
    // re-surfaces the form) and complete the job without a failure audit.
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
    // A provider quota / rate-limit error is a RETRYABLE condition, not a
    // semantic turn failure: the model call was refused, nothing ran, and
    // the limit resolves by itself ("You will regain access on … UTC").
    // With `retryLimit:0` the throw below would fail the task terminally
    // and LOSE the turn over a billing window. Park instead: re-enqueue a
    // fresh job with `startAfter` at the provider's stated reset time (or a
    // per-kind backoff), bounded by PROVIDER_LIMIT_PARK_MAX so the task
    // cannot ping-pong forever. The mcp_tasks row stays non-terminal, so
    // `tasks/get` keeps deriving `working` until the parked turn runs.
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
        // Make the wait legible to whoever is polling. The task row stays
        // non-terminal on purpose — the turn WILL run — but "not terminal" must
        // not mean "indistinguishable from working".
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
        // The park re-enqueue itself failed — fall through to the terminal
        // failure path so the task can never be silently lost in limbo.
        log.queue.job.failed({
          msg: "conversation.run-turn park re-enqueue failed — falling back to terminal failure",
          queue: CONVERSATION_RUN_TURN_QUEUE,
          job_id: job.id,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
          duration_ms: Date.now() - started,
        });
      }
    }
    const failureReason = err instanceof Error ? err.message : String(err);
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
        actor_type: data.actor_id ? "user" : "system",
        actor_id: data.actor_id,
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
    // Re-throw so pg-boss records the job as failed → DLQ.
    throw err;
  } finally {
    // (i) Always release the registry slot.
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
        // Bridge the enqueuing tenant across the queue boundary so every
        // downstream conversation.* log inherits the originating context.
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
