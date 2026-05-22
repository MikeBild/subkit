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

import { and, eq } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  isExpectedCancellation,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import * as svc from "../../conversations/service.ts";
import type { Db } from "../../db/client.ts";
import { conversationMessages } from "../../db/schema/index.ts";
import { log } from "../../logging/logger.ts";
import {
  type ConversationTurnEnvelope,
  getMcpTask,
  setMcpTaskFailure,
  setMcpTaskResult,
} from "../../mcp/tasks/store.ts";
import { CONVERSATION_RUN_TURN_QUEUE, type ConversationRunTurnJob } from "../queues.ts";

export interface RegisterConversationRunTurnOptions {
  boss: PgBoss;
  db: Db;
}

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

async function handleOne(job: Job<ConversationRunTurnJob>, db: Db): Promise<void> {
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
  if (task.result || task.failure_reason || task.cancelled_at) {
    log.queue.job.completed({
      msg: "conversation.run-turn job already terminal — idempotent no-op",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      duration_ms: Date.now() - started,
    });
    return;
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
          output: elicitation.output,
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
          user_message: message,
          surface: "mcp",
          turn_abort_ctrl: turnAbortCtrl,
          ...(data.permission_mode ? { permission_mode: data.permission_mode } : {}),
          ...(data.runtime_context ? { runtime_context: data.runtime_context } : {}),
        },
        db,
      );
    }

    // (g) Success — persist the terminal CallToolResult envelope.
    await setMcpTaskResult(data.tenant_id, data.mcp_task_id, toEnvelope(outcome), db);
    log.queue.job.completed({
      msg: "conversation.run-turn job completed",
      queue: CONVERSATION_RUN_TURN_QUEUE,
      job_id: job.id,
      duration_ms: Date.now() - started,
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
    const failureReason = err instanceof Error ? err.message : String(err);
    await setMcpTaskFailure(data.tenant_id, data.mcp_task_id, failureReason, db);
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
        await handleOne(job, db);
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
): Promise<string | null> {
  return await boss.send(CONVERSATION_RUN_TURN_QUEUE, payload);
}
