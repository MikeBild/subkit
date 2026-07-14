// Dead-letter consumer for the `conversation.run-turn` queue.
//
// `conversation.run-turn` has `retryLimit:0` — a turn makes real,
// non-idempotent LLM + external calls, so replaying it would
// double-charge tokens and re-fire side effects. The run-turn worker's
// own `catch` writes a terminal `mcp_tasks` column for a turn it threw
// inside. But if the worker PROCESS dies mid-turn — the engine host
// has a documented OOM-restart history — the `catch` never runs:
// pg-boss expires the job and dead-letters it to
// `conversation.run-turn.dlq`. With nothing consuming that DLQ the
// `mcp_tasks` row keeps no terminal column and `deriveTask` reports
// `working` forever, so the client polls forever.
//
// This consumer closes that gap. The dead-lettered job's `data` still
// carries the original `ConversationRunTurnJob` envelope — `mcp_task_id`,
// `tenant_id`, `conversation_id`. The consumer marks the `mcp_tasks`
// row `failed` with `failure_reason: "worker_expired"` (idempotent: a
// row already terminal — the worker did finish, or this DLQ job is a
// redelivery — is left untouched) and writes the
// `CONVERSATION_TURN_FAILED` audit row.

import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/logger.ts";
import { getMcpTask, setMcpTaskFailureIfNotTerminal } from "../../mcp/tasks/store.ts";
import { withJobContext } from "../job-context.ts";
import { CONVERSATION_RUN_TURN_DLQ, type ConversationRunTurnJob } from "../queues.ts";

/** Machine-readable failure code stamped on a worker-expired task. */
export const WORKER_EXPIRED_FAILURE_REASON = "worker_expired";

export interface RegisterConversationRunTurnDlqOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<ConversationRunTurnJob>, db: Db): Promise<void> {
  const data = job.data;
  // A malformed envelope (no ids) can't be reconciled — log and drop.
  if (!data?.tenant_id || !data?.mcp_task_id) {
    log.queue.job.failed({
      msg: "conversation.run-turn.dlq job missing ids — dropping",
      queue: CONVERSATION_RUN_TURN_DLQ,
      job_id: job.id,
      error: "dlq_envelope_missing_ids",
    });
    return;
  }

  // Failure stamp + audit row commit as ONE unit: the audit is the
  // operator-visible evidence of the expiry, and an observer who can see
  // `failure_reason` must also find the audit row (a two-commit sequence
  // left a window where the state change was visible without evidence).
  const stamped = await db.transaction(async (tx) => {
    const didStamp = await setMcpTaskFailureIfNotTerminal(
      data.tenant_id,
      data.mcp_task_id,
      WORKER_EXPIRED_FAILURE_REASON,
      tx,
    );
    if (!didStamp) return false;

    // The conversation_id is needed for the audit resource_id; fall back
    // to a re-read only when the envelope somehow omits it.
    let conversationId = data.conversation_id;
    if (!conversationId) {
      const row = await getMcpTask(data.tenant_id, data.mcp_task_id, tx);
      conversationId = row?.conversation_id ?? "";
    }

    await auditAwait(
      {
        tenant_id: data.tenant_id,
        actor_type: data.actor_id ? "user" : "system",
        actor_id: data.actor_id ?? null,
        action: AuditAction.CONVERSATION_TURN_FAILED,
        resource_type: "conversation",
        resource_id: conversationId,
        result: "error",
        reason: WORKER_EXPIRED_FAILURE_REASON,
        metadata: { mcp_task_id: data.mcp_task_id, kind: data.kind, dead_lettered: true },
      },
      tx,
    );
    return true;
  });
  if (!stamped) {
    // The row is already terminal — the worker finished before the
    // process died, or this DLQ job is a redelivery. Idempotent no-op.
    log.queue.job.completed({
      msg: "conversation.run-turn.dlq job — mcp_tasks row already terminal, no-op",
      queue: CONVERSATION_RUN_TURN_DLQ,
      job_id: job.id,
    });
    return;
  }

  log.queue.job.completed({
    msg: "conversation.run-turn.dlq job — mcp_tasks row marked failed (worker_expired)",
    queue: CONVERSATION_RUN_TURN_DLQ,
    job_id: job.id,
    tenant_id: data.tenant_id,
  });
}

export async function registerConversationRunTurnDlqHandler(
  opts: RegisterConversationRunTurnDlqOptions,
): Promise<string> {
  const { boss, db } = opts;
  const workerId = await boss.work<ConversationRunTurnJob>(
    CONVERSATION_RUN_TURN_DLQ,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<ConversationRunTurnJob>[]) => {
      for (const job of jobs) {
        await withJobContext(job.data, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "conversation.run-turn.dlq worker registered",
    worker_id: workerId,
  });
  return workerId;
}
