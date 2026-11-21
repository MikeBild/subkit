import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { type Actor, actorOf } from "../audit/actor.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { ConversationTurnInProgressError } from "../conversations/types.ts";
import type { Db } from "../db/client.ts";
import { executions, toolApprovals } from "../db/schema/index.ts";
import { rehydrateExecutionPrincipal } from "../execution/authorization-context.ts";
import { errorFields, logger } from "../logging/index.ts";
import { insertMcpTask, setMcpTaskFailure, setMcpTaskJobId } from "../mcp/tasks/store.ts";
import { enqueueConversationRunTurn } from "./handlers/conversation-run-turn.ts";

const TURN_RELEASE_WAIT_MS = 5_000;
const TURN_RELEASE_POLL_MS = 50;

async function afterCurrentTurn<T>(enqueue: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + TURN_RELEASE_WAIT_MS;
  for (;;) {
    try {
      return await enqueue();
    } catch (error) {
      if (!(error instanceof ConversationTurnInProgressError) || Date.now() >= deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, TURN_RELEASE_POLL_MS));
    }
  }
}

async function approvalOwnerPrincipal(
  tenant_id: string,
  approval_id: string,
  db: Db,
  decision: "approve" | "decline",
): Promise<ResolvedPrincipal | null> {
  const [owner] = await db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.tenant_id, tenant_id), eq(toolApprovals.id, approval_id)))
    .limit(1);
  if (
    !owner ||
    owner.consumed_at ||
    owner.expires_at <= new Date() ||
    (decision === "approve" ? !owner.granted_at || owner.declined_at : !owner.declined_at)
  )
    return null;
  let caller = owner.caller_context;
  let authorization = owner.authorization_context;
  if (!caller && !authorization) {
    const linked = await db
      .select({
        caller: executions.caller_context,
        authorization: executions.authorization_context,
      })
      .from(executions)
      .where(and(eq(executions.tenant_id, tenant_id), eq(executions.tool_approval_id, approval_id)))
      .limit(2);
    if (linked.length !== 1) return null;
    caller = linked[0]?.caller ?? null;
    authorization = linked[0]?.authorization ?? null;
  }
  const principal = await rehydrateExecutionPrincipal(db, caller, authorization);
  return principal?.id === owner.principal_id ? principal : null;
}

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
  let runAs: ResolvedPrincipal | null;
  try {
    runAs = await approvalOwnerPrincipal(p.tenant_id, p.approval_id, db, p.decision);
  } catch (error) {
    logger.warn({
      module: "queue",
      action: "approval_resume.authentication_refused",
      msg: "Approved continuation requires fresh authenticated preparation.",
      tenant_id: p.tenant_id,
      approval_id: p.approval_id,
      ...errorFields(error),
    });
    return false;
  }
  if (!runAs) {
    logger.warn({
      module: "queue",
      action: "approval_resume.authentication_refused",
      msg: "Approved continuation requires fresh authenticated preparation.",
      tenant_id: p.tenant_id,
      approval_id: p.approval_id,
    });
    return false;
  }
  const actor: Actor | null =
    runAs.kind === "user"
      ? actorOf(runAs)
      : p.approver_user_id
        ? { kind: "user", id: p.approver_user_id }
        : null;
  const actor_id = actor?.id ?? null;

  let task_id: string;
  try {
    task_id = await insertMcpTask(
      {
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        kind: "respond_elicitation",
        actor,
        request_source: "portal",
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
    await setMcpTaskJobId(p.tenant_id, task_id, attempt_id, db);
    const job_id = await afterCurrentTurn(() =>
      enqueueConversationRunTurn(
        boss,
        db,
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
      ),
    );
    if (!job_id) {
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
