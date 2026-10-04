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

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { roles, systemAccounts, toolApprovals, users } from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { insertMcpTask, setMcpTaskFailure, setMcpTaskJobId } from "../mcp/tasks/store.ts";
import { enqueueConversationRunTurn } from "./handlers/conversation-run-turn.ts";

/** The principal that owns an approval, resolved to the shape
 *  `applyElicitationOutcome` claims with. Mirrors
 *  `conversations/tools/permission-gate.ts#resolveConversationPrincipal`, but
 *  keyed on `tool_approvals.principal_id` instead of a live request actor —
 *  which is the whole point: the browser approver is usually unidentifiable, and
 *  the claim CAS binds this id. */
async function approvalOwnerPrincipal(
  tenant_id: string,
  approval_id: string,
  db: Db,
): Promise<ResolvedPrincipal | null> {
  const [owner] = await db
    .select({ principal_id: toolApprovals.principal_id })
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenant_id), eq(toolApprovals.id, approval_id)))
    .limit(1);
  const id = owner?.principal_id;
  if (!id) return null;

  const [user] = await db
    .select({ role_name: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.id, id), eq(users.tenant_id, tenant_id)))
    .limit(1);
  if (user) {
    const roleNames = user.role_name ? [user.role_name] : [];
    return { provider: "conversation_tool", kind: "user", id, tenant_id, roles: roleNames };
  }

  const [account] = await db
    .select({ id: systemAccounts.id })
    .from(systemAccounts)
    .where(and(eq(systemAccounts.id, id), eq(systemAccounts.tenant_id, tenant_id)))
    .limit(1);
  if (account) {
    return { provider: "conversation_tool", kind: "system_account", id, tenant_id, roles: [] };
  }
  return null;
}

/** Enqueue a `respond_elicitation` turn for a portal-decided approval.
 *
 *  Returns false when the job could not be queued; the caller leaves the row
 *  staged and the elicitation-expiry backstop reconciles it. */
export async function enqueueApprovalElicitationResume(
  p: {
    tenant_id: string;
    conversation_id: string;
    elicitation_id: string;
    approval_id: string;
    approver_user_id: string | null;
    decision: "approve" | "decline";
  },
  db: Db,
  boss: PgBoss,
): Promise<boolean> {
  // WHO THE RESUMED TURN RUNS AS. Not the approver: the approval portal is
  // unauthenticated, so the human who decided is frequently unidentifiable, and
  // `resolveConversationPrincipal` derives the principal from `actor_id` — a null
  // actor yields no principal, `applyElicitationOutcome` fails
  // `principal_required`, and the held call is never claimed. Observed on prod:
  // the approved knowledge source was still created, but by the model RE-ISSUING
  // the tool after the pause cleared rather than by the harness replaying the
  // exact arguments the human reviewed, and `consumed_at` stayed null.
  //
  // The owning principal is the right identity on both counts: it is the one
  // `consumeApproval`'s CAS binds, and it is the one whose RBAC the original call
  // already passed. Attribution of the DECISION stays separate, on
  // `approver_user_id` / `granted_by_user_id`.
  const runAs = await approvalOwnerPrincipal(p.tenant_id, p.approval_id, db);
  // `mcp_tasks.actor_id` references `users`, while `tool_approvals.principal_id`
  // is polymorphic (a user OR a system account), so only a real user may land
  // there. The principal itself rides the job envelope, which is what
  // `applyElicitationOutcome` actually claims with.
  const actor_id = runAs?.kind === "user" ? runAs.id : p.approver_user_id;

  let task_id: string;
  try {
    task_id = await insertMcpTask(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        kind: "respond_elicitation",
        // The approval's owning principal, when it is a user — see above.
        actor_id,
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
    const attempt_id = randomUUID();
    // Bind the attempt before enqueue so a worker can never publish a result
    // without first owning the task row it belongs to.
    await setMcpTaskJobId(p.tenant_id, task_id, attempt_id, db);
    const job_id = await enqueueConversationRunTurn(
      boss,
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        mcp_task_id: task_id,
        actor_id,
        ...(runAs ? { principal: runAs } : {}),
        kind: "respond_elicitation",
        elicitation_id: p.elicitation_id,
        answer_channel: "portal",
        approver_user_id: p.approver_user_id,
        ...(p.decision === "decline" ? { reason: "user_declined" } : {}),
      },
      { id: attempt_id },
    );
    if (!job_id) {
      // pg-boss dedup or a rejected send. Mark the task failed rather than
      // leaving it deriving `working` forever.
      await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_failed", db);
      return false;
    }
    if (job_id !== attempt_id) {
      await setMcpTaskFailure(p.tenant_id, task_id, "enqueue_id_mismatch", db);
      return false;
    }
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
