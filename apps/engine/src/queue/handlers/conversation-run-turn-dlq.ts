import type { Job, PgBoss } from "pg-boss";
import { auditAwait } from "../../audit/audit.ts";
import { resolveActor } from "../../audit/recorders/types.ts";
import { AuditAction } from "../../audit/types.ts";
import { workerExpiredTurnFailure } from "../../conversations/public/authoring.ts";
import {
  recordConversationTurnFailure,
  stopConversationTaskTurn,
} from "../../conversations/public/lifecycle.ts";
import type { Db } from "../../db/client.ts";
import { log } from "../../logging/index.ts";
import {
  getMcpTask,
  laterTurnCompleted,
  setMcpTaskFailureIfNotTerminal,
} from "../../mcp/tasks/store.ts";
import { recordUsageEvent } from "../../stats/index.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { CONVERSATION_RUN_TURN_DLQ, type ConversationRunTurnJob } from "../queues.ts";

const WORKER_EXPIRED_FAILURE_REASON = "worker_expired";

interface RegisterConversationRunTurnDlqOptions {
  boss: PgBoss;
  db: Db;
}

async function handleOne(job: Job<ConversationRunTurnJob>, db: Db): Promise<void> {
  const data = job.data;
  if (!data?.tenant_id || !data?.mcp_task_id) {
    log.queue.job.failed({
      msg: "conversation.run-turn.dlq job missing ids — dropping",
      queue: CONVERSATION_RUN_TURN_DLQ,
      job_id: job.id,
      error: "dlq_envelope_missing_ids",
    });
    return;
  }

  const stamped = await db.transaction(async (tx) => {
    const didStamp = await setMcpTaskFailureIfNotTerminal(
      data.tenant_id,
      data.mcp_task_id,
      WORKER_EXPIRED_FAILURE_REASON,
      tx,
      data.attempt_id,
    );
    if (!didStamp) return false;

    const task = await getMcpTask(data.tenant_id, data.mcp_task_id, tx);
    const conversationId = data.conversation_id ?? task?.conversation_id ?? "";

    await auditAwait(
      {
        tenant_id: data.tenant_id,
        ...resolveActor(
          task
            ? { actor_type: task.actor_kind ?? "unknown", actor_id: task.actor_id }
            : { actor_type: "unknown", actor_id: null },
        ),
        action: AuditAction.CONVERSATION_TURN_FAILED,
        resource_type: "conversation",
        resource_id: conversationId,
        result: "error",
        reason: WORKER_EXPIRED_FAILURE_REASON,
        metadata: {
          mcp_task_id: data.mcp_task_id,
          kind: data.kind,
          dead_lettered: true,
          request_source: task?.request_source ?? null,
        },
      },
      tx,
    );
    if (
      conversationId &&
      !(task && (await laterTurnCompleted(data.tenant_id, conversationId, task.turn_seq, tx)))
    ) {
      await recordConversationTurnFailure(
        tx,
        data.tenant_id,
        conversationId,
        workerExpiredTurnFailure(),
      );
    }
    return true;
  });
  if (data.turn_id && data.attempt_id && data.conversation_id) {
    const task = await getMcpTask(data.tenant_id, data.mcp_task_id, db);
    if (task?.failure_reason === WORKER_EXPIRED_FAILURE_REASON) {
      await stopConversationTaskTurn(
        db,
        data.tenant_id,
        data.conversation_id,
        data.turn_id,
        data.mcp_task_id,
        data.attempt_id,
      );
    }
  }
  if (!stamped) {
    log.queue.job.completed({
      msg: "conversation.run-turn.dlq job — mcp_tasks row already terminal, no-op",
      queue: CONVERSATION_RUN_TURN_DLQ,
      job_id: job.id,
    });
    return;
  }

  recordUsageEvent(db, {
    tenantId: data.tenant_id,
    surface: "conversations",
    operation: "mcp/turn",
    method: "EVENT",
    outcome: "server_error",
    requestSource: "mcp",
    actorId: data.actor_id,
    sessionId: data.conversation_id,
    platform: "http",
    responseMode: "async",
    taskPhase: "failed",
  });

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
        await withActiveTenantJobContext(job.data, db, () => handleOne(job, db));
      }
    },
  );
  log.queue.worker.registered({
    msg: "conversation.run-turn.dlq worker registered",
    worker_id: workerId,
  });
  return workerId;
}
