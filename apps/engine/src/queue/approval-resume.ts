// Enqueue the conversation turn that applies an approval decision made
// out-of-band in the browser portal.
//
// This is the queue-layer half of `conversations/approval-completion.ts`. It
// lives here so that module stays free of the queue and MCP-task layers, and so
// the direction of dependency stays the established one (queue → conversations,
// never the reverse).
//
// Shape copied from `mcp/capabilities/conversations.ts` `backgroundTurn`, which
// is the only other producer of `conversation.run-turn` jobs: mint the task row
// first (`mcp_task_id` is required on the envelope and is what makes the worker
// idempotent), enqueue, then record the job id — or record an explicit failure,
// so a lost enqueue never leaves a task that reads as still working.
//
// The turn runs in the worker rather than in the browser's request because
// `respondElicitation` runs the whole LLM turn in-process: driving it inline
// would hold the approval page open for minutes and hand the operator a timeout
// instead of a confirmation.

import type { PgBoss } from "pg-boss";
import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { insertMcpTask, setMcpTaskFailure, setMcpTaskJobId } from "../mcp/tasks/store.ts";
import { enqueueConversationRunTurn } from "./handlers/conversation-run-turn.ts";

/** Enqueue a `respond_elicitation` turn for a portal-decided approval.
 *
 *  Returns false when the job could not be queued; the caller leaves the row
 *  staged and the elicitation-expiry backstop reconciles it. */
export async function enqueueApprovalElicitationResume(
  p: {
    tenant_id: string;
    conversation_id: string;
    elicitation_id: string;
    approver_user_id: string | null;
    decision: "approve" | "decline";
  },
  db: Db,
  boss: PgBoss,
): Promise<boolean> {
  let task_id: string;
  try {
    task_id = await insertMcpTask(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        kind: "respond_elicitation",
        // The approver, when the portal could identify them. A decision by an
        // unidentified browser is attributed to no one rather than to a machine.
        actor_id: p.approver_user_id,
        request_source: "portal",
        // A resumed elicitation carries no new user message.
        user_message_id: null,
      },
      db,
    );
  } catch (err) {
    logger.error({
      module: "queue",
      action: "approval_resume.task_insert_failed",
      msg: "could not mint the task row for a portal-decided approval resume",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation_id,
      ...errorFields(err),
    });
    return false;
  }

  try {
    const job_id = await enqueueConversationRunTurn(boss, {
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      mcp_task_id: task_id,
      actor_id: p.approver_user_id,
      kind: "respond_elicitation",
      elicitation_id: p.elicitation_id,
      answer_channel: "portal",
      approver_user_id: p.approver_user_id,
      ...(p.decision === "decline" ? { reason: "user_declined" } : {}),
    });
    if (!job_id) {
      // pg-boss dedup or a rejected send. Mark the task failed rather than
      // leaving it deriving `working` forever.
      await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_failed", db);
      return false;
    }
    await setMcpTaskJobId(p.tenant_id, task_id, job_id, db);
    return true;
  } catch (err) {
    logger.error({
      module: "queue",
      action: "approval_resume.enqueue_failed",
      msg: "could not enqueue the conversation turn for a portal-decided approval",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation_id,
      ...errorFields(err),
    });
    await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_failed", db).catch(() => {});
    return false;
  }
}
